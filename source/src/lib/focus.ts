// Focus: quiet hours (new-mail notifications only for the people and subjects let through) and work mail by
// network (work accounts hidden off work networks outside work hours, except what's let through). The pure
// rules, unit-tested (test/focus.test.ts); the background's FocusService applies them and writes `focusState`,
// which the Ember window follows. (No imports from page modules: the background bundles this file.)

export interface WorkNetwork { key: string; name: string }

export interface FocusSettings {
  /** Days of the work week (0 Sunday … 6 Saturday), and the work day's hours ("HH:MM", local time). */
  workDays: number[];
  workStart: string;
  workEnd: string;
  /** "outsideWork": quiet outside work hours; "always": quiet all the time (only let-through mail notifies). */
  quietHours: "off" | "outsideWork" | "always";
  /** Let through: addresses or names, and words in subjects. */
  letThroughPeople: string[];
  letThroughSubjects: string[];
  /** Accounts whose mail is work mail (by account id). None: nothing is ever hidden. */
  workAccounts: string[];
  workNetworks: WorkNetwork[];
  /** Work mail shows on a work network, and ("networkOrHours") during work hours anywhere. */
  workMailRule: "networkOrHours" | "network";
  /** From the sidebar: quiet on/off, or work mail shown, until a time. */
  focusOverride: { quiet?: boolean; showWork?: boolean; until: number } | null;
}

export const FOCUS_DEFAULTS: FocusSettings = {
  workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "17:00",
  quietHours: "off", letThroughPeople: [], letThroughSubjects: [],
  workAccounts: [], workNetworks: [], workMailRule: "networkOrHours", focusOverride: null,
};

export interface FocusState {
  quiet: boolean;
  /** Work accounts hidden now (empty when work mail shows). */
  hiddenAccounts: string[];
  onWorkNetwork: boolean;
  inWorkHours: boolean;
  /** The network now (null when unknown) and its name if it's a work network. */
  network: { key: string | null; name?: string; dns?: string[] } | null;
  /** When this may change next by the clock (work hours start or end, an override ending). */
  nextChange: number | null;
  at: number;
}

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

/** Whether `time` falls in work hours (a day's span; an end before the start runs past midnight). */
export function inWorkHours(s: Pick<FocusSettings, "workDays" | "workStart" | "workEnd">, time: number): boolean {
  const d = new Date(time);
  const now = d.getHours() * 60 + d.getMinutes(), start = minutes(s.workStart), end = minutes(s.workEnd);
  if (start === end) return false;
  if (start < end) return s.workDays.includes(d.getDay()) && now >= start && now < end;
  // Overnight shift: the evening part belongs to today, the early part to yesterday's work day.
  return (s.workDays.includes(d.getDay()) && now >= start) || (s.workDays.includes((d.getDay() + 6) % 7) && now < end);
}

/** The next time work hours start or end after `time` (within two weeks). */
export function nextWorkChange(s: Pick<FocusSettings, "workDays" | "workStart" | "workEnd">, time: number): number | null {
  if (!s.workDays.length || minutes(s.workStart) === minutes(s.workEnd)) return null;
  const was = inWorkHours(s, time);
  const day = new Date(time); day.setSeconds(0, 0);
  for (let i = 0; i < 15; i++) {
    for (const hhmm of [s.workStart, s.workEnd].sort((a, b) => minutes(a) - minutes(b))) {
      const at = new Date(day); at.setDate(day.getDate() + i); at.setHours(Math.floor(minutes(hhmm) / 60), minutes(hhmm) % 60, 0, 0);
      if (+at > time && inWorkHours(s, +at) !== was) return +at;
    }
  }
  return null;
}

/** The focus state now, from the settings and the network. */
export function focusState(s: FocusSettings, network: { key: string | null; dns?: string[] } | null, time: number): FocusState {
  const work = inWorkHours(s, time);
  const workNet = network?.key ? s.workNetworks.find((n) => n.key === network.key) : undefined;
  const override = s.focusOverride && s.focusOverride.until > time ? s.focusOverride : null;
  let quiet = s.quietHours === "always" || (s.quietHours === "outsideWork" && !work);
  if (override?.quiet !== undefined) quiet = override.quiet;
  const showWork = !!workNet || (s.workMailRule === "networkOrHours" && work) || !!override?.showWork;
  const changes = [nextWorkChange(s, time), override?.until ?? null].filter((x): x is number => x !== null);
  return {
    quiet, hiddenAccounts: showWork ? [] : [...s.workAccounts], onWorkNetwork: !!workNet, inWorkHours: work,
    network: network ? { key: network.key, ...(workNet ? { name: workNet.name } : {}), ...(network.dns?.length ? { dns: network.dns } : {}) } : null,
    nextChange: changes.length ? Math.min(...changes) : null, at: time,
  };
}

/** "ada@x.org, Grace Hopper; board" → ["ada@x.org", "Grace Hopper", "board"] */
export function parseList(text: string): string[] {
  return [...new Set(String(text || "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Whether an email is let through: from one of the people (address or name) or with one of the words in its subject. */
export function letThrough(s: Pick<FocusSettings, "letThroughPeople" | "letThroughSubjects">, m: { author?: string; subject?: string }): boolean {
  const author = String(m.author || "").toLowerCase();
  const address = (/<([^>]+)>/.exec(author)?.[1] || author).trim();
  const name = author.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
  const person = s.letThroughPeople.some((p) => {
    const want = p.toLowerCase();
    if (want.includes("@")) return address === want || (want.startsWith("@") && address.endsWith(want));
    return name.includes(want);
  });
  const subject = String(m.subject || "").toLowerCase();
  return person || s.letThroughSubjects.some((w) => subject.includes(w.toLowerCase()));
}

/** Whether new mail should notify now: not junk, in an Inbox, not hidden, and (when quiet) let through. */
export function shouldNotify(s: FocusSettings, state: FocusState, m: { author?: string; subject?: string; accountId?: string; junk?: boolean }): boolean {
  if (m.junk) return false;
  const through = letThrough(s, m);
  if (m.accountId && state.hiddenAccounts.includes(m.accountId) && !through) return false;
  return !state.quiet || through;
}

/** Whether Ember announces new mail itself (Thunderbird's alerts off): with quiet hours or work mail rules set. */
export function sparkAnnounces(s: FocusSettings, time = Date.now()): boolean {
  return s.quietHours !== "off" || s.workAccounts.length > 0 || (!!s.focusOverride?.quiet && s.focusOverride.until > time);
}

/** The Focus menu's times: an hour from now, and when work hours next start (or tomorrow 8 AM). */
export function quietChoices(s: Pick<FocusSettings, "workDays" | "workStart" | "workEnd">, time: number): { hour: number; morning: number } {
  let morning = nextWorkChange(s, time);
  if (morning !== null && inWorkHours(s, time)) morning = nextWorkChange(s, morning);
  if (morning === null) { const d = new Date(time); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); morning = +d; }
  return { hour: time + 3600000, morning };
}

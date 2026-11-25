// Rolling performance recorder for diagnosing lag on real mailboxes. It keeps the last few
// minutes of timings (inputs, slow frames, stalls, Ember work, Thunderbird API latency) and
// exports them as a report. It records timings and counts only: never subjects, addresses,
// folder names or message content.

import { errorLog } from "./error-log";

export interface PerfEntry { t: number; kind: string; ms?: number; [key: string]: unknown }

const LIMIT = 20000;
const WINDOW_MS = 5 * 60000;
const SPAN_MIN_MS = 2;
const STALL_MS = 80;
const FRAME_MS = 34;
const FRAME_WATCH_MS = 2000;
const PING_MS = 2000;
/** Full-detail watching (50 ms stall checks, Thunderbird pings) lasts this long after input; then it idles. */
const ACTIVE_MS = 60000;
const IDLE_STALL_MS = 500;

const now = () => performance.timeOrigin + performance.now();

/** Which key, without recording typed text: anything aimed at a text field is just "text". */
function keyOf(event: KeyboardEvent): { key: string; mods?: string } {
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  const mods = [event.metaKey && "meta", event.ctrlKey && "ctrl", event.altKey && "alt", event.shiftKey && "shift"].filter(Boolean).join("+");
  const key = typing && event.key.length === 1 && !event.metaKey && !event.ctrlKey ? "text" : event.key === " " ? "Space" : event.key;
  return mods ? { key, mods } : { key };
}

export class PerfRecorder {
  enabled = true;
  private entries: PerfEntry[] = [];
  private stopFns: (() => void)[] = [];

  record(kind: string, data: Record<string, unknown> = {}) {
    // Failures are also kept (recorder on or off) in the error log, beyond this recorder's five minutes.
    if (kind === "error") errorLog.add(String(data.text ?? ""), data.stack ? String(data.stack) : undefined);
    this.push({ t: Math.round(now()), kind, ...data });
  }

  /** Start a timed span; the returned function records it if it took long enough to matter. */
  span(kind: string, data: Record<string, unknown> = {}): (extra?: Record<string, unknown>) => void {
    if (!this.enabled) return () => {};
    const start = now();
    return (extra = {}) => {
      const ms = now() - start;
      if (ms >= SPAN_MIN_MS) this.push({ t: Math.round(start), kind, ms: Math.round(ms * 10) / 10, ...data, ...extra });
    };
  }

  measure<T>(kind: string, work: () => T, data: Record<string, unknown> = {}): T {
    const end = this.span(kind, data);
    try { return work(); } finally { end(); }
  }

  track<T>(kind: string, work: Promise<T>, data: Record<string, unknown> = {}): Promise<T> {
    const end = this.span(kind, data);
    return work.then((value) => { end(); return value; }, (error) => { end({ failed: true }); throw error; });
  }

  private push(entry: PerfEntry) {
    if (!this.enabled) return;
    this.entries.push(entry);
    if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT);
  }

  recent(): PerfEntry[] {
    const since = now() - WINDOW_MS;
    return this.entries.filter((entry) => entry.t >= since);
  }

  /** Page observers: interaction latency, slow frames around input, event-loop stalls, Thunderbird round trips. */
  observe(ping?: () => Promise<unknown>) {
    this.stop();
    if (!this.enabled || typeof window === "undefined") return;
    const describe = (target: unknown) => {
      const el = target as Element | null;
      if (!el?.closest) return undefined;
      return el.closest(".row") ? "list-row" : el.closest(".reader") ? "reader" : el.closest(".viewport") ? "list" : el.closest("aside, nav") ? "sidebar" : el.tagName?.toLowerCase();
    };
    try {
      const observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[]) {
          this.push({ t: Math.round(performance.timeOrigin + e.startTime), kind: "input", name: e.name, ms: Math.round(e.duration), delay: Math.round(e.processingStart - e.startTime), handlers: Math.round(e.processingEnd - e.processingStart), target: describe(e.target) });
        }
      });
      observer.observe({ type: "event", durationThreshold: 16, buffered: false } as PerformanceObserverInit);
      this.stopFns.push(() => observer.disconnect());
    } catch { this.record("note", { text: "Event Timing unavailable" }); }

    // Watch frames only for a moment after input; an always-on rAF loop would keep the app busy.
    // Stall checks and Thunderbird pings run at full rate only while Ember is in use (they were 90% of
    // Ember's idle CPU): a stall nobody is waiting on matters less than waking the page 20 times a second.
    let watchUntil = 0, frame = 0, last = 0, activeUntil = performance.now() + ACTIVE_MS;
    const tick = (time: number) => {
      const gap = time - last; last = time;
      if (gap > FRAME_MS) this.push({ t: Math.round(performance.timeOrigin + time - gap), kind: "frame", ms: Math.round(gap) });
      frame = performance.now() < watchUntil ? requestAnimationFrame(tick) : 0;
    };
    const onInput = (event: Event) => {
      if (event.type === "keydown") this.record("user", { name: event.type, target: describe(event.target), ...keyOf(event as KeyboardEvent) });
      else if (event.type !== "wheel") this.record("user", { name: event.type, target: describe(event.target) });
      watchUntil = performance.now() + FRAME_WATCH_MS;
      const wasIdle = performance.now() > activeUntil;
      activeUntil = performance.now() + ACTIVE_MS;
      if (wasIdle) { clearTimeout(stallTimer); expected = performance.now(); scheduleStall(); }
      if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); }
    };
    for (const type of ["pointerdown", "keydown", "wheel"]) window.addEventListener(type, onInput, { capture: true, passive: true });
    this.stopFns.push(() => { for (const type of ["pointerdown", "keydown", "wheel"]) window.removeEventListener(type, onInput, { capture: true }); cancelAnimationFrame(frame); });

    let expected = performance.now(), period = 50, stallTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleStall = () => {
      // Hidden: no stall checks at all (nothing to see); visibilitychange starts them again.
      if (document.visibilityState !== "visible") { stallTimer = undefined; return; }
      period = performance.now() < activeUntil ? 50 : IDLE_STALL_MS;
      expected = performance.now();
      stallTimer = setTimeout(() => {
        const at = performance.now(); const late = at - expected - period;
        if (late > STALL_MS && document.visibilityState === "visible") this.push({ t: Math.round(performance.timeOrigin + at - late), kind: "stall", ms: Math.round(late) });
        scheduleStall();
      }, period);
    };
    scheduleStall();
    const onVisible = () => { if (document.visibilityState === "visible" && stallTimer === undefined) scheduleStall(); };
    document.addEventListener("visibilitychange", onVisible);
    this.stopFns.push(() => { clearTimeout(stallTimer); document.removeEventListener("visibilitychange", onVisible); });

    if (ping) {
      const pings = setInterval(() => {
        if (document.visibilityState !== "visible" || performance.now() > activeUntil) return;
        const start = now();
        void ping().then(() => { const ms = now() - start; if (ms > 30) this.push({ t: Math.round(start), kind: "thunderbird-ping", ms: Math.round(ms) }); }, () => {});
      }, PING_MS);
      this.stopFns.push(() => clearInterval(pings));
    }
  }

  stop() { for (const fn of this.stopFns.splice(0)) fn(); }

  private watching = false;
  /** Script errors and unhandled rejections, whether or not the recorder is on (once per page). They explain a
   *  frozen view (0.1.63: a duplicate list key stopped Pins redrawing). */
  watchErrors(target: any = globalThis) {
    if (this.watching || typeof target?.addEventListener !== "function") return;
    this.watching = true;
    const onError = (event: Event) => {
      const error = (event as ErrorEvent).error ?? (event as PromiseRejectionEvent).reason ?? (event as ErrorEvent).message;
      this.record("error", { text: String(error?.message || error).slice(0, 300), stack: String(error?.stack || "").slice(0, 600) });
    };
    target.addEventListener("error", onError);
    target.addEventListener("unhandledrejection", onError);
  }

  setEnabled(enabled: boolean, ping?: () => Promise<unknown>) {
    this.enabled = enabled;
    if (enabled) this.observe(ping); else { this.stop(); this.entries = []; }
  }

  /** The report: environment, the slowest moments with what overlapped them, and the raw timeline. */
  report(environment: Record<string, unknown>, background: PerfEntry[] = []): Record<string, unknown> {
    const entries = [...this.recent(), ...background.map((entry) => ({ ...entry, source: "background" }))].sort((a, b) => a.t - b.t);
    const slow = entries.filter((e) => (e.kind === "input" || e.kind === "frame" || e.kind === "stall") && (e.ms || 0) >= 50).sort((a, b) => (b.ms || 0) - (a.ms || 0)).slice(0, 20);
    const worst = slow.map((moment) => ({
      moment,
      during: entries.filter((e) => e !== moment && e.t <= moment.t + (moment.ms || 0) + 100 && e.t + (e.ms || 0) >= moment.t - 300).slice(0, 60),
    }));
    return { format: "spark-performance-report/1", createdAt: new Date().toISOString(), windowMinutes: WINDOW_MS / 60000, environment, worst, entries };
  }
}

export const perf = new PerfRecorder();

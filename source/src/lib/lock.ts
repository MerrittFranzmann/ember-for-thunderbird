// Lock with Touch ID: Ember covers your mail until you unlock it with Touch ID (or your Mac's password). The
// settings and the texts, pure and unit-tested (test/lock.test.ts). The lock Experiment
// (public/experiments/lock) watches for the moments to lock (away, sleep, screen locked, Thunderbird starting)
// and asks macOS; the background's LockService passes it these settings and whether this network is trusted.
// (No imports from page modules: the background bundles this file.)

export interface TrustedNetwork { key: string; name: string }

export interface LockSettings {
  lockEnabled: boolean;
  /** Lock after this many minutes without using the Mac (keyboard, mouse, trackpad); 0: never. */
  lockAfter: number;
  /** Lock when the Mac goes to sleep or its screen locks. */
  lockOnSleep: boolean;
  /** Lock when Thunderbird starts. */
  lockOnStart: boolean;
  /** On these networks (by Focus's network key) Ember doesn't lock by itself. */
  lockTrustedNetworks: TrustedNetwork[];
}

export const LOCK_DEFAULTS: LockSettings = {
  lockEnabled: false, lockAfter: 15, lockOnSleep: true, lockOnStart: true, lockTrustedNetworks: [],
};

export const LOCK_AFTER_CHOICES: [number, string][] = [
  [1, "After 1 minute"], [5, "After 5 minutes"], [15, "After 15 minutes"], [30, "After 30 minutes"], [60, "After 1 hour"], [0, "Never"],
];

/** Why Ember locked: you locked it, away from the Mac, the Mac slept, its screen locked, Thunderbird started. */
export type LockReason = "manual" | "away" | "sleep" | "screen" | "start";

export interface LockState { locked: boolean; reason?: LockReason; at?: number }

/** What the Experiment needs (it keeps it in a pref, so the lock works before the background starts). */
export function lockConfig(s: LockSettings) {
  return { enabled: !!s.lockEnabled, idleMinutes: Math.max(0, Number(s.lockAfter) || 0), onSleep: !!s.lockOnSleep, onStart: !!s.lockOnStart };
}

/** Whether the network (Focus's key for it) is one Ember doesn't lock on. */
export function trustedNetwork(s: Pick<LockSettings, "lockTrustedNetworks">, key: string | null | undefined): TrustedNetwork | undefined {
  return key ? s.lockTrustedNetworks.find((n) => n.key === key) : undefined;
}

/** The line under "Ember is locked". */
export function lockReasonText(reason: LockReason | undefined, idleMinutes: number): string {
  switch (reason) {
    case "away": return idleMinutes >= 60 ? `Locked after ${idleMinutes / 60 === 1 ? "an hour" : `${idleMinutes / 60} hours`} away from your Mac.` : `Locked after ${idleMinutes === 1 ? "a minute" : `${idleMinutes} minutes`} away from your Mac.`;
    case "sleep": return "Locked when your Mac went to sleep.";
    case "screen": return "Locked when your Mac's screen locked.";
    case "start": return "Locked when Thunderbird started.";
    default: return "Your mail stays hidden until you unlock Ember.";
  }
}

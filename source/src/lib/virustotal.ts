// VirusTotal for attachments: what its scanners say about a file, found by the file's fingerprint (SHA-256), so
// the file itself never leaves the Mac. A file VirusTotal hasn't seen can be uploaded, only when the user asks
// (VirusTotal shares uploaded files with security companies and its paying customers). Pure and unit-tested
// (test/virustotal.test.ts); the page's scanner (virustotal-scanner.svelte.ts) asks through the sparkScan
// Experiment with the user's own API key.

export interface ScanStats { malicious: number; suspicious: number; harmless: number; undetected: number; total: number }

export type ScanStatus =
  | "hashing" | "checking" | "waiting" // working (waiting: the free key's 4-a-minute limit)
  | "clean" | "suspicious" | "flagged" | "unknown" // answers
  | "uploading" | "analysing" // an upload the user asked for
  | "error";

export interface ScanResult {
  status: ScanStatus;
  sha256?: string;
  stats?: ScanStats;
  /** The engines that flagged it and what they call it (a few). */
  threat?: string;
  error?: string;
  at?: number;
}

export const DONE: ScanStatus[] = ["clean", "suspicious", "flagged", "unknown", "error"];
export const BUSY: ScanStatus[] = ["hashing", "checking", "waiting", "uploading", "analysing"];

/** VirusTotal's link for a file (its report page). */
export const reportUrl = (sha256: string) => `https://www.virustotal.com/gui/file/${sha256}`;

/** Engine counts from VirusTotal's last_analysis_stats (file) or stats (analysis). */
export function scanStats(raw: Record<string, number> | null | undefined): ScanStats | null {
  if (!raw || typeof raw !== "object") return null;
  const n = (k: string) => Math.max(0, Number(raw[k]) || 0);
  const malicious = n("malicious"), suspicious = n("suspicious"), harmless = n("harmless"), undetected = n("undetected");
  // Engines that couldn't scan this kind of file (type-unsupported, timeout, failure) don't count.
  const total = malicious + suspicious + harmless + undetected;
  return { malicious, suspicious, harmless, undetected, total };
}

/** Flagged when any engine calls it malicious; suspicious when only "suspicious"; clean otherwise. */
export function verdict(stats: ScanStats): "clean" | "suspicious" | "flagged" {
  if (stats.malicious > 0) return "flagged";
  if (stats.suspicious > 0) return "suspicious";
  return "clean";
}

/** The short line beside the file. */
export function scanText(r: ScanResult | undefined): string {
  if (!r) return "";
  const s = r.stats;
  switch (r.status) {
    case "hashing": case "checking": return "Checking with VirusTotal…";
    case "waiting": return "Waiting for VirusTotal (4 checks a minute)…";
    case "uploading": return "Uploading to VirusTotal…";
    case "analysing": return "VirusTotal is scanning it…";
    case "clean": return s && s.total ? `No scanner flags it (0 of ${s.total})` : "No scanner flags it";
    case "suspicious": return `${s?.suspicious ?? 0} of ${s?.total ?? 0} scanners find it suspicious`;
    case "flagged": return `Flagged by ${s?.malicious ?? 0} of ${s?.total ?? 0} scanners${r.threat ? ` · ${r.threat}` : ""}`;
    case "unknown": return "VirusTotal hasn't seen this file";
    case "error": return r.error || "Couldn't check with VirusTotal";
  }
}

const DAY = 86400000;
/** How long an answer is kept before asking again: a file nobody has scanned may be scanned soon. */
export function fresh(r: ScanResult | undefined, now: number): boolean {
  if (!r?.at || !DONE.includes(r.status) || r.status === "error") return false;
  const keep = r.status === "unknown" ? DAY : r.status === "clean" ? 7 * DAY : 30 * DAY;
  return now - r.at < keep;
}

/** The answers kept in storage (by fingerprint): the newest `max`. */
export function pruneResults(results: Record<string, ScanResult>, now: number, max = 2000): Record<string, ScanResult> {
  const kept = Object.entries(results).filter(([, r]) => fresh(r, now)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, max);
  return Object.fromEntries(kept);
}

/** What the engines that flag it call it ({ engine: name }): the most common names, up to two. */
export function threatName(flagged: Record<string, string> | null | undefined): string | undefined {
  const counts = new Map<string, number>();
  for (const name of Object.values(flagged || {})) if (name) counts.set(name, (counts.get(name) || 0) + 1);
  const names = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name);
  return names.length ? names.join(", ") : undefined;
}

/** The few words on an attachment's badge (the full line is its tooltip). */
export function scanBadge(r: ScanResult | undefined): string {
  switch (r?.status) {
    case "hashing": case "checking": return "Checking…";
    case "waiting": return "Waiting…";
    case "uploading": return "Uploading…";
    case "analysing": return "Scanning…";
    case "clean": return "Clean";
    case "suspicious": return "Suspicious";
    case "flagged": return `Flagged ${r.stats?.malicious ?? 0}/${r.stats?.total ?? 0}`;
    case "unknown": return "Not scanned";
    case "error": return "Couldn't check";
    default: return "Check";
  }
}

/** A VirusTotal API key: 64 hex characters. */
export const validKey = (key: string) => /^[0-9a-f]{64}$/i.test(String(key || "").trim());

/** The free key's limit: `perMinute` requests in any 60 s. `wait()` says how long until the next may go. */
export class RateLimit {
  private sent: number[] = [];
  constructor(private perMinute = 4, private now: () => number = Date.now) {}
  wait(): number {
    const t = this.now();
    this.sent = this.sent.filter((at) => t - at < 60000);
    return this.sent.length < this.perMinute ? 0 : 60000 - (t - this.sent[0]) + 50;
  }
  take() { this.sent.push(this.now()); }
  /** VirusTotal said too many: nothing more for a minute. */
  full() { const t = this.now(); this.sent = Array.from({ length: this.perMinute }, () => t); }
}

/** A known test file VirusTotal flags (the EICAR test string's SHA-256), to check a key works. Only the hash. */
export const EICAR_SHA256 = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f";

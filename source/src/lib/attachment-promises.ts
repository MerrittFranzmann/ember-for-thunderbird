// "Before you send", attachments: the email says a file is attached ("I've attached…", "see the spreadsheet")
// but none is, or not that kind; or an attached file looks like an older version of one already in the
// conversation (report-v2 when report-v3 was sent). Pure; unit-tested (test/attachment-promises.test.ts).
import type { SendWarning } from "./send-checks";

export type FileKind = "spreadsheet" | "presentation" | "pdf" | "document" | "image" | "video" | "archive";

const KIND_WORDS: [FileKind, RegExp][] = [
  ["spreadsheet", /\b(spreadsheets?|sheets?|excel|xlsx?|csv|workbooks?)\b/i],
  ["presentation", /\b(decks?|slides?|slide deck|presentations?|powerpoint|pptx?|keynote)\b/i],
  ["pdf", /\bpdfs?\b/i],
  ["document", /\b(word doc(ument)?|docx?|google doc|documents?)\b/i],
  ["image", /\b(photos?|pictures?|pics?|images?|screenshots?|screen shots?|jpe?g|png)\b/i],
  ["video", /\b(videos?|mp4|mov|recording)\b/i],
  ["archive", /\b(zip( file)?|archive)\b/i],
];
const KIND_EXT: Record<FileKind, string[]> = {
  spreadsheet: ["xls", "xlsx", "xlsm", "csv", "numbers", "ods", "tsv"],
  presentation: ["ppt", "pptx", "key", "odp"],
  pdf: ["pdf"],
  // A "document" is often sent as a PDF.
  document: ["doc", "docx", "pages", "odt", "rtf", "txt", "md", "pdf"],
  image: ["jpg", "jpeg", "png", "heic", "gif", "webp", "tif", "tiff", "bmp", "svg"],
  video: ["mp4", "mov", "m4v", "avi", "mkv", "webm"],
  archive: ["zip", "7z", "rar", "tar", "gz"],
};
const KIND_LINK: Partial<Record<FileKind, RegExp>> = {
  spreadsheet: /docs\.google\.com\/spreadsheets|\.xlsx?\b|:x:\/|sheets\.new/i,
  presentation: /docs\.google\.com\/presentation|\.pptx?\b|:p:\//i,
  document: /docs\.google\.com\/document|\.docx?\b|:w:\//i,
};
const KIND_NAME: Record<FileKind, string> = { spreadsheet: "a spreadsheet", presentation: "slides", pdf: "a PDF", document: "a document", image: "a photo", video: "a video", archive: "a zip file" };

/** Saying something is in this email: "attached", "enclosed", "see the …", "here's the …", "I've included …". */
const PROMISE = /\b(attach(ed|ing|ments?)?|enclosed|see the|here(?:'|’)?s the|here is the|here are the|sending (?:you )?the|i(?:'|’)ve included|i have included|including the|find the)\b/i;
/** …but about the other person's file ("thanks for the attached", "your attachment", "the file you sent"). */
const THEIRS = /\b(your|thanks for|thank you for|you sent|you attached|you(?:'|’)ve attached|you shared|did you|can you|could you|please (?:send|attach|share))\b/i;

export const extensionOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] || "").toLowerCase();
export const kindOf = (name: string): FileKind | null => (Object.keys(KIND_EXT) as FileKind[]).find((kind) => kind !== "document" && KIND_EXT[kind].includes(extensionOf(name))) ?? (KIND_EXT.document.includes(extensionOf(name)) ? "document" : null);

/** Sentences of the user's own text that promise a file, with the kinds they name. */
export function promises(text: string): { sentence: string; kinds: FileKind[] }[] {
  return text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean)
    .filter((sentence) => PROMISE.test(sentence) && !THEIRS.test(sentence))
    .map((sentence) => ({ sentence, kinds: KIND_WORDS.filter(([, words]) => words.test(sentence)).map(([kind]) => kind) }));
}

// ---- versions: "budget v2", "budget_v3 FINAL", "budget (1)", "budget 2026-10-28" ----
export interface VersionedName { base: string; version: number | null; date: number | null; final: boolean }
export function versionOf(name: string): VersionedName {
  let stem = name.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  let date: number | null = null, version: number | null = null;
  const iso = /(20\d\d)[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/.exec(stem);
  if (iso) { date = Date.UTC(+iso[1], +iso[2] - 1, +iso[3]); stem = stem.replace(iso[0], " "); }
  const v = /(?:^|[\s_\-.(])(?:v|ver|version|rev|r)[\s_\-.]?(\d{1,3})(?=$|[\s_\-.)])/.exec(stem);
  if (v) { version = +v[1]; stem = stem.replace(v[0], " "); }
  const copy = /\s*\((\d{1,2})\)\s*$/.exec(stem);
  if (copy && version === null) { version = +copy[1]; stem = stem.replace(copy[0], " "); }
  const final = /\bfinal\b/.test(stem);
  stem = stem.replace(/\b(final|draft|updated|update|revised|new|latest|copy|clean|edits?)\b/g, " ");
  return { base: stem.replace(/[\s_\-.()]+/g, " ").trim(), version, date, final };
}

/** Whether `a` looks older than `b` (same file, an earlier version, date or a draft of the final). */
export function olderThan(a: string, b: string): boolean {
  if (extensionOf(a) !== extensionOf(b)) return false;
  const x = versionOf(a), y = versionOf(b);
  if (!x.base || x.base !== y.base) return false;
  if (x.date !== null && y.date !== null && x.date !== y.date) return x.date < y.date;
  if (x.version !== null && y.version !== null && x.version !== y.version) return x.version < y.version;
  if (x.version === null && y.version !== null && y.version > 1 && x.date === null) return true;
  return !x.final && y.final && (x.version === null || x.version === y.version);
}

export interface ThreadFile { name: string; from: string; date: number; messageId: number; partName: string }
export interface AttachmentCheck {
  /** The user's own text (no quoted email, no signature). */
  text: string;
  /** Files attached to this email (forwarded ones included). */
  files: { name: string }[];
  /** Links in the email (a shared spreadsheet keeps "see the spreadsheet" true). */
  links: string[];
  /** Files already in the conversation, newest first. */
  thread: ThreadFile[];
}

const when = (time: number) => new Date(time).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

export function attachmentWarnings({ text, files, links, thread }: AttachmentCheck): SendWarning[] {
  const warnings: SendWarning[] = [];
  const said = promises(text);
  const attachedKinds = new Set(files.map((f) => kindOf(f.name)));
  const linked = (kind: FileKind) => !!KIND_LINK[kind] && links.some((url) => KIND_LINK[kind]!.test(url));
  const quote = (s: string) => `“${s.length > 90 ? `${s.slice(0, 87)}…` : s}”`;
  if (said.length && !files.length) {
    const kinds = [...new Set(said.flatMap((p) => p.kinds))].filter((kind) => !linked(kind));
    const explicit = said.some((p) => /\battach|enclosed/i.test(p.sentence));
    if (explicit || kinds.length) {
      const first = said.find((p) => /\battach|enclosed/i.test(p.sentence) || p.kinds.some((k) => kinds.includes(k)))!;
      warnings.push({ key: "attachMissing", kind: "attachMissing", text: kinds.length === 1 ? `You mention ${KIND_NAME[kinds[0]]}, but nothing is attached.` : "You mention an attachment, but nothing is attached.", detail: quote(first.sentence), fix: { label: "Attach a file", attach: true } });
    }
  } else if (said.length) {
    for (const p of said) {
      const missing = p.kinds.filter((kind) => !attachedKinds.has(kind) && !(kind === "pdf" && attachedKinds.has("document")) && !linked(kind));
      // "the document" with a PDF attached is fine (KIND_EXT.document includes pdf).
      const reallyMissing = missing.filter((kind) => !(kind === "document" && files.some((f) => KIND_EXT.document.includes(extensionOf(f.name)))));
      if (!reallyMissing.length) continue;
      const kind = reallyMissing[0];
      if (warnings.some((w) => w.key === `attachKind:${kind}`)) continue;
      warnings.push({ key: `attachKind:${kind}`, kind: "attachKind", text: `You mention ${KIND_NAME[kind]}, but none is attached.`, detail: `${quote(p.sentence)} Attached: ${files.map((f) => f.name).join(", ")}.`, fix: { label: "Attach a file", attach: true } });
    }
  }
  for (const file of files) {
    const newer = thread.find((t) => olderThan(file.name, t.name));
    if (!newer) continue;
    warnings.push({
      key: `olderVersion:${file.name}`, kind: "olderVersion", text: `${file.name} looks older than ${newer.name} in this conversation.`,
      detail: `${newer.from} sent ${newer.name} on ${when(newer.date)}.`,
      fix: { label: `Use ${newer.name}`, swap: { name: file.name, messageId: newer.messageId, partName: newer.partName, with: newer.name } },
    });
  }
  return warnings;
}

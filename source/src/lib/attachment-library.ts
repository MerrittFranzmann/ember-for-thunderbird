import type { ReceivedAttachment } from "./attachments";
import type { MessageAttachment, MessageHeader } from "./types";
import { displayName, emailOf } from "./format";
export type FileKind = "pdf" | "image" | "document" | "spreadsheet" | "presentation" | "archive" | "audio" | "video" | "calendar" | "other";
export type FileGrouping = "none" | "sender" | "conversation";
export const FILE_KINDS: [FileKind | "all", string][] = [["all","All file types"],["pdf","PDFs"],["image","Images"],["document","Documents"],["spreadsheet","Spreadsheets"],["presentation","Presentations"],["archive","Archives"],["audio","Audio"],["video","Video"],["calendar","Invitations"],["other","Other files"]];
export function fileKind(file: MessageAttachment): FileKind {
  const type = (file.contentType || "").toLowerCase(); const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("image/") || /^(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|svg)$/.test(ext)) return "image";
  if (type === "text/calendar" || /^(ics|ical)$/.test(ext)) return "calendar";
  if (type.startsWith("audio/") || /^(mp3|m4a|wav|aiff|flac|ogg)$/.test(ext)) return "audio";
  if (type.startsWith("video/") || /^(mp4|mov|webm|mkv|avi)$/.test(ext)) return "video";
  if (/spreadsheet|excel|csv/.test(type) || /^(xlsx?|csv|ods|numbers)$/.test(ext)) return "spreadsheet";
  if (/presentation|powerpoint/.test(type) || /^(pptx?|odp|key)$/.test(ext)) return "presentation";
  if (/zip|compressed|archive|x-tar/.test(type) || /^(zip|rar|7z|tar|gz|bz2)$/.test(ext)) return "archive";
  if (/word|opendocument.text|rtf/.test(type) || /^(docx?|odt|rtf|txt|md|pages)$/.test(ext)) return "document";
  return "other";
}
export function previewKind(file: MessageAttachment): "pdf" | "image" | null {
  if (/^(image\/svg\+xml|text\/html|application\/xhtml\+xml)$/i.test(file.contentType)) return null;
  if (fileKind(file) === "pdf") return "pdf";
  // SVG/HTML are never embedded as documents. Only the browser's raster image decoder is used.
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(file.contentType.toLowerCase()) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name)) return "image";
  return null;
}
export interface FileGroup { key: string; label?: string; files: ReceivedAttachment[]; }
export function groupFiles(files: ReceivedAttachment[], grouping: FileGrouping, conversation: (message: MessageHeader) => { key: string; label: string }): FileGroup[] {
  if (grouping === "none") return [{ key: "all", files }];
  const groups = new Map<string, FileGroup>();
  for (const file of files) {
    const sender = emailOf(file.message.author).toLowerCase() || file.message.author;
    const source = grouping === "sender" ? { key: sender, label: `${displayName(file.message.author)}${sender ? ` · ${sender}` : ""}` } : conversation(file.message);
    if (!groups.has(source.key)) groups.set(source.key, { ...source, files: [] });
    groups.get(source.key)!.files.push(file);
  }
  return [...groups.values()].sort((a, b) => grouping === "sender" ? a.label!.localeCompare(b.label!) : +new Date(b.files[0].message.date) - +new Date(a.files[0].message.date));
}

import type { MessagePart } from "./types";
/** Small session LRU; never stores failures and never persists Thunderbird IDs. */
export class MemoryCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(private maxEntries = 64, private maxBytes = 24 * 1024 * 1024, private size: (value: T) => number = (value) => JSON.stringify(value).length * 2) {}
  get(key: string): T | undefined { const entry = this.entries.get(key); if (!entry) return undefined; this.entries.delete(key); this.entries.set(key, entry); return entry.value; }
  set(key: string, value: T) { this.delete(key); const bytes = this.size(value); if (bytes > this.maxBytes) return; this.entries.set(key, { value, bytes }); this.bytes += bytes; while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value!); }
  delete(key: string) { const entry = this.entries.get(key); if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); } }
  clear() { this.entries.clear(); this.bytes = 0; }
}
export function mimeBytes(part: MessagePart): number {
  let bytes = 256 + (part.body?.length || 0) * 2;
  for (const values of Object.values(part.headers || {})) for (const value of values) bytes += value.length * 2;
  for (const child of part.parts || []) bytes += mimeBytes(child);
  return bytes;
}

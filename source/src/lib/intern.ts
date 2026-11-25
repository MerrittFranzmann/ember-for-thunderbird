// One shared copy of the values thousands of saved headers repeat. Every header arrives as its own
// copy (IndexedDB rows, Thunderbird query results, structured clones between background and page): its
// folder object alone was ~30% of a header, and 600 headers had 7 folders, 95 senders and 8 recipient
// lists. Callers never mutate these values in place (they're replaced), so sharing is safe.
// Unit-tested in test/intern.test.ts. (No page imports: the background bundles this.)

export class HeaderInterner {
  private strings = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private folders = new Map<string, unknown>();

  string<T>(value: T): T {
    if (typeof value !== "string") return value;
    const shared = this.strings.get(value);
    if (shared !== undefined) return shared as T;
    this.strings.set(value, value);
    return value;
  }

  list<T>(value: T): T {
    if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string")) return value;
    const key = value.join("\u0001");
    let shared = this.lists.get(key);
    if (!shared) { shared = value.map((item) => this.string(item)); this.lists.set(key, shared); }
    return shared as T;
  }

  folder<T>(value: T): T {
    if (!value || typeof value !== "object") return value;
    const key = JSON.stringify(value);
    const shared = this.folders.get(key);
    if (shared) return shared as T;
    this.folders.set(key, value);
    return value;
  }

  /** Replace a header's repeated fields with the shared copies (in place); returns the header. */
  header<T extends Record<string, any>>(header: T): T {
    const h = header as Record<string, any>;
    if (h.folder) h.folder = this.folder(h.folder);
    if (h.author) h.author = this.string(h.author);
    if (h.recipients) h.recipients = this.list(h.recipients);
    if (h.ccList) h.ccList = this.list(h.ccList);
    if (h.bccList) h.bccList = this.list(h.bccList);
    if (h.tags) h.tags = this.list(h.tags);
    return header;
  }
}

/** A 53-bit fingerprint of a string (two 32-bit FNV-1a passes), to tell whether a saved value changed. */
export function fingerprint(text: string): number {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) & 0x1fffff);
}

/** A page of headers for the background → page transfer, each distinct folder sent once (a folder
 *  object was ~30% of every header's clone). Headers keep their folder by reference in `folderRef`. */
export function packFolders<T extends { folder?: unknown }>(headers: T[]): { headers: (Omit<T, "folder"> & { folderRef?: number })[]; folders: unknown[] } {
  const index = new Map<unknown, number>();
  const folders: unknown[] = [];
  const packed = headers.map((header) => {
    if (!header.folder) return header;
    let ref = index.get(header.folder);
    if (ref === undefined) { ref = folders.length; folders.push(header.folder); index.set(header.folder, ref); }
    const { folder: _folder, ...rest } = header;
    return { ...rest, folderRef: ref };
  });
  return { headers: packed, folders };
}

/** Undo packFolders on a received page (in place; the page adopts copies of these headers anyway). */
export function unpackFolders<P extends { headers?: any[]; folders?: unknown[] }>(page: P): P {
  if (!page || !Array.isArray(page.folders) || !Array.isArray(page.headers)) return page;
  for (const header of page.headers) {
    if (typeof header.folderRef !== "number") continue;
    header.folder = page.folders[header.folderRef];
    delete header.folderRef;
  }
  delete page.folders;
  return page;
}

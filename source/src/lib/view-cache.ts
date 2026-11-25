import type { MessageHeader, View } from "./types";

/** Smart Inbox and its category lenses use the same underlying mailbox data. */
export function datasetKey(view: View): string {
  if (view.kind === "smart") return view.inbox ? `smart:${view.inbox}` : "smart";
  if (view.kind === "category") {
    if (view.cat === "pinned") return `pinned:${view.folderId ? `folder:${view.folderId}` : view.accountId || "all"}`;
    if (view.folderId) return `folder:${view.folderId}`;
    if (view.accountId) return `mailbox:inbox:${view.accountId}`;
    return view.inbox ? `smart:${view.inbox}` : "smart";
  }
  if (view.kind === "folder") return `folder:${view.folderId}`;
  if (view.kind === "mailbox") return `mailbox:${view.role}:${view.accountId || "all"}`;
  if (view.kind === "pinned") return `pinned:${view.accountId || "all"}`;
  if (view.kind === "trip") return `trip:${view.id}`;
  if (view.kind === "search") return `search:${view.scope || "local"}:${view.query.trim()}:${JSON.stringify(view.filters || {})}`;
  return view.kind;
}

export function navigationKey(view: View): string {
  return view.kind === "category" ? `category:${view.cat}:${datasetKey(view)}` : datasetKey(view);
}

export interface ViewSnapshot {
  view: View;
  headers: Map<number, MessageHeader>;
  folderIds: Set<string>;
  attachmentIds: Set<number>;
  savedAt: number;
  dirty: boolean;
}

/** Session-only: Thunderbird message IDs are not stable across app restarts. */
export class ViewCache {
  private entries = new Map<string, ViewSnapshot>();
  constructor(private limit = 8, private maxAge = 60000) {}

  get(view: View): ViewSnapshot | undefined {
    const key = datasetKey(view);
    const snapshot = this.entries.get(key);
    if (snapshot) {
      this.entries.delete(key);
      this.entries.set(key, snapshot);
    }
    return snapshot;
  }

  put(view: View, headers: Map<number, MessageHeader>, folderIds: Set<string>, attachmentIds: Set<number>) {
    if (view.kind === "attachments") return;
    const key = datasetKey(view);
    this.entries.delete(key);
    this.entries.set(key, { view: { ...view }, headers: new Map(headers), folderIds: new Set(folderIds), attachmentIds: new Set(attachmentIds), savedAt: Date.now(), dirty: false });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  needsRefresh(snapshot: ViewSnapshot): boolean {
    return snapshot.dirty || Date.now() - snapshot.savedAt >= this.maxAge;
  }

  setAttachmentFlags(view: View, ids: Set<number>) {
    const snapshot = this.entries.get(datasetKey(view));
    if (snapshot) snapshot.attachmentIds = new Set(ids);
  }

  markSearchDirty() { for (const snapshot of this.entries.values()) if (snapshot.view.kind === "search" && snapshot.view.scope !== "all") snapshot.dirty = true; }

  /** Keep only this view's snapshot (Ember hidden for a while). */
  keepOnly(view: View) { const key = datasetKey(view); for (const k of Array.from(this.entries.keys())) if (k !== key) this.entries.delete(k); }
  markDirty() {
    for (const snapshot of this.entries.values()) snapshot.dirty = true;
  }

  update(message: MessageHeader, changed: Partial<MessageHeader>) {
    for (const snapshot of this.entries.values()) {
      const cached = snapshot.headers.get(message.id);
      if (cached) Object.assign(cached, changed);
      if ((snapshot.view.kind === "pinned" || (snapshot.view.kind === "category" && snapshot.view.cat === "pinned")) && changed.flagged !== undefined) {
        if (!changed.flagged) snapshot.headers.delete(message.id);
        snapshot.dirty = true;
      }
      if (changed.junk !== undefined) snapshot.dirty = true;
    }
  }

  remove(ids: number[]) {
    for (const snapshot of this.entries.values()) {
      for (const id of ids) {
        snapshot.headers.delete(id);
        snapshot.attachmentIds.delete(id);
      }
      snapshot.dirty = true;
    }
  }
}

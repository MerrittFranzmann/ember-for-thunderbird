// Ember's outbox (outbox.ts): emails waiting to be sent, in the extension's own IndexedDB so they survive
// Ember closing and Thunderbird restarting, attachments included. The Ember page adds and takes back emails;
// the background sends them. Taking back (Undo, Edit) and claiming for sending are each one transaction, so
// an email is never both sent and put back in the composer. Every change bumps storage.local `outboxRev`,
// which the page watches. (No imports from page modules: the background bundles this file.)
import type { QueuedEmail } from "./outbox";

const DB_NAME = "spark-outbox";
const STORE = "emails";

export class OutboxStore {
  private db: Promise<IDBDatabase> | null = null;
  /** `idb`: tests pass their own; by default the page's (read when first used). */
  constructor(private native: any, private idb?: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    this.db ||= new Promise<IDBDatabase>((resolve, reject) => {
      const request = (this.idb ?? indexedDB).open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => { this.db = null; throw error; });
    return this.db;
  }

  /** Run `work` in one readwrite (or readonly) transaction; resolves with its result once committed. */
  private async run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result: T;
      work(tx.objectStore(STORE), (value) => { result = value; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Outbox transaction aborted"));
    });
  }

  private changed() {
    return Promise.resolve(this.native?.storage?.local.set({ outboxRev: Date.now() })).catch(() => {});
  }

  all(): Promise<QueuedEmail[]> {
    return this.run<QueuedEmail[]>("readonly", (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => done((request.result as QueuedEmail[]).sort((a, b) => a.sendAt - b.sendAt));
    });
  }

  async put(email: QueuedEmail) {
    await this.run<void>("readwrite", (store) => { store.put(email); });
    await this.changed();
  }

  /** Change an email (not its contents); null when it's gone. */
  async update(id: string, change: Partial<QueuedEmail>, when?: (email: QueuedEmail) => boolean): Promise<QueuedEmail | null> {
    const updated = await this.run<QueuedEmail | null>("readwrite", (store, done) => {
      done(null);
      const request = store.get(id);
      request.onsuccess = () => {
        const email = request.result as QueuedEmail | undefined;
        if (!email || (when && !when(email))) return;
        const next = { ...email, ...change };
        store.put(next);
        done(next);
      };
    });
    if (updated) await this.changed();
    return updated;
  }

  /** Take an email back out (Undo, Edit): removed and returned, unless it's being sent right now. */
  async take(id: string): Promise<QueuedEmail | null> {
    const taken = await this.run<QueuedEmail | null>("readwrite", (store, done) => {
      done(null);
      const request = store.get(id);
      request.onsuccess = () => {
        const email = request.result as QueuedEmail | undefined;
        if (!email || email.state === "sending") return;
        store.delete(id);
        done(email);
      };
    });
    if (taken) await this.changed();
    return taken;
  }

  /** For sending: a waiting email whose time has come (or any waiting one with `now`), marked "sending". */
  claim(id: string, now = Date.now()): Promise<QueuedEmail | null> {
    return this.update(id, { state: "sending", error: undefined }, (email) => email.state === "waiting" && email.sendAt <= now);
  }

  async remove(id: string) {
    await this.run<void>("readwrite", (store) => { store.delete(id); });
    await this.changed();
  }
}

// Thin wrapper over the MailExtension globals with version/feature detection.
// Every function used here is documented at
// https://webextension-api.thunderbird.net/en/latest/ (MV3).

import type { MessageHeader, MessageList } from "./types";
import { CacheClient } from "./cache-client";
import { LocalMailCache, cachedAPI } from "./local-mail-cache";
import { perf } from "./perf-recorder";

// `messenger` is Thunderbird's alias of `browser`.
const native: any = (globalThis as any).messenger ?? (globalThis as any).browser;
export const mailCache = native?.runtime?.sendMessage ? new CacheClient(native) : new LocalMailCache(native);
export const api: any = timedAPI(cachedAPI(native, mailCache));

/** A plain copy of what Ember saves or sends: Thunderbird structured-clones it, which refuses Svelte's reactive
 *  proxies ($state), so a value taken from page state failed to save, silently behind a .catch (0.1.106: the
 *  agent status). Plain objects and arrays are copied (that's what the proxies are); anything else (Date, File,
 *  Blob, Map…) is passed as it is. */
export function plain<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
  if (seen.has(value)) return seen.get(value) as T;
  const copy: any = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = plain(item, seen);
  return copy;
}

/** A failed save or send goes to the performance log (most callers ignore it), then on to the caller. */
function noted(what: string, work: any): any {
  if (!work || typeof work.then !== "function") return work;
  return work.then(undefined, (error: any) => {
    const text = String(error?.message || error);
    // No page listening (Settings closed, background asleep) is normal for a message.
    if (!/Receiving end does not exist|Could not establish connection/.test(text)) perf.record("error", { text: `${what}: ${text}`.slice(0, 300) });
    throw error;
  });
}

/** storage.*.set and runtime.sendMessage with plain values (see `plain`). */
function cloneSafe(object: any, method: string, what: string): any {
  return new Proxy(object, { get(target, property: string) {
    const value = target[property];
    if (typeof value !== "function") return value;
    if (property !== method) return (...args: any[]) => value.apply(target, args);
    return (...args: any[]) => noted(what, value.apply(target, args.map((arg) => plain(arg))));
  } });
}
function cloneSafeStorage(storage: any): any {
  const areas = new Map<string, any>();
  return new Proxy(storage, { get(target, property: string) {
    const value = target[property];
    if (!["local", "sync", "session"].includes(property) || !value) return value;
    if (!areas.has(property)) areas.set(property, cloneSafe(value, "set", `storage.${property}.set`));
    return areas.get(property);
  } });
}

/** Time Thunderbird API calls (for the performance recorder); events and properties pass through. */
function timedAPI(target: any): any {
  if (!target) return target;
  const wrapped = new Map<string, any>();
  const namespace = (name: string, ns: any) => new Proxy(ns, { get(object, property: string) {
    const value = object[property];
    if (typeof value !== "function") return value;
    return (...args: any[]) => { const result = value.apply(object, args); return result && typeof result.then === "function" ? perf.track(`thunderbird.${name}.${property}`, result) : result; };
  } });
  return new Proxy(target, { get(object, property: string) {
    const value = object[property];
    if (property === "runtime" && value) {
      if (!wrapped.has(property)) wrapped.set(property, cloneSafe(value, "sendMessage", "runtime.sendMessage"));
      return wrapped.get(property);
    }
    if (!["messages", "folders", "accounts", "compose", "messageDisplay", "storage"].includes(property) || !value) return value;
    if (!wrapped.has(property)) wrapped.set(property, namespace(property, property === "storage" ? cloneSafeStorage(value) : value));
    return wrapped.get(property);
  } });
}

let tbMajor = 128;

export async function initEnv(): Promise<number> {
  try {
    const info = await api.runtime.getBrowserInfo();
    tbMajor = parseInt(String(info.version), 10) || 128;
  } catch {
    /* keep default */
  }
  return tbMajor;
}

export const env = {
  get tb() {
    return tbMajor;
  },
  /** messages.getHeaders — TB 147+. Faster than getFull for classification. */
  get hasGetHeaders() {
    return typeof api?.messages?.getHeaders === "function";
  },
  /** messages.sendMessage / saveMessage — TB 153+: background send, no compose window. */
  get hasBackgroundSend() {
    return typeof api?.messages?.sendMessage === "function";
  },
  /** Ember's calendar Experiment: Exchange meeting responses and Thunderbird-format iMIP replies. */
  get hasCalendarResponses() {
    return typeof api?.sparkCalendar?.sendReply === "function";
  },
  /** Ember's window Experiment: Ember-only mode (Thunderbird's own window hidden). */
  get hasSparkOnly() {
    return typeof api?.sparkWindow?.configure === "function";
  },
  /** Ember's print Experiment: a conversation as PDF. */
  get hasPdf() {
    return typeof api?.sparkPrint?.htmlToPDF === "function";
  },
  /** Ember's update Experiment: signed releases from GitHub (or a local release folder in tests). */
  get hasUpdates() {
    return typeof api?.sparkUpdate?.check === "function";
  },
  get hasBackgroundSave() {
    return typeof api?.messages?.saveMessage === "function";
  },
  /** messages.list sort options — TB 148+. */
  get hasListSort() {
    return tbMajor >= 148;
  },
  get hasContactsQuery() {
    return typeof api?.addressBooks?.contacts?.query === "function";
  },
  /** move/delete isUserAction option — TB 137+. */
  get hasUserAction() {
    return tbMajor >= 137;
  },
};

/** Iterate every page of a MessageList (list/query/event payloads). */
export async function* pages(first: MessageList | Promise<MessageList>): AsyncGenerator<MessageHeader[]> {
  let page = await first;
  while (page) {
    if (page.messages?.length) yield page.messages;
    if (!page.id) return;
    page = await api.messages.continueList(page.id);
  }
}

export async function drain(first: MessageList | Promise<MessageList>): Promise<MessageHeader[]> {
  const all: MessageHeader[] = [];
  for await (const p of pages(first)) all.push(...p);
  return all;
}

export function listFolder(folderId: string): Promise<MessageList> {
  if (env.hasListSort) {
    return api.messages.list(folderId, { sortType: "date", sortOrder: "descending" });
  }
  return api.messages.list(folderId);
}

export function abortList(id: string | null | undefined) {
  if (id && typeof api?.messages?.abortList === "function") {
    api.messages.abortList(id).catch(() => {});
  }
}

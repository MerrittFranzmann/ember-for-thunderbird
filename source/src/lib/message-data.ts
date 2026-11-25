import { mailCache } from "./api";
import { store } from "./store.svelte";
import { MessageLoader, type LoadedMessage } from "./message-loader";
const loader = new MessageLoader(() => {
  const releaseMeta = store.meta.hold(); const releaseCache = mailCache.hold();
  return () => { releaseMeta(); releaseCache(); };
});
export function forgetMessage(id: number) { loader.forget(id); const forget = (mailCache as any).forget; if (typeof forget === "function") forget.call(mailCache, id); }
export function loadMessageBody(api: any, id: number) { return loader.body(api, id); }
export function trimMessages() { loader.clear(); }
export function loadMessage(api: any, id: number, onBody?: (message: LoadedMessage) => void) { return loader.load(api, id, onBody); }

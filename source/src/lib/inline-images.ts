import { withDeadline } from "./async";
import { messageKey } from "./local-mail-cache";
import { MemoryCache } from "./memory-cache";
import type { MessageAttachment, MessageHeader } from "./types";
const memory = new MemoryCache<string>(48, 12 * 1024 * 1024, (value) => value.length * 2);
const pending = new Map<string, Promise<string>>();
/** Drop decoded inline images (Ember hidden for a while). */
export function trimInlineImages() { memory.clear(); }
export function inlineImage(api: any, message: MessageHeader, attachment: MessageAttachment): Promise<string> {
  const key = `${messageKey(message)}:${attachment.partName}:${attachment.size}`;
  const saved = memory.get(key); if (saved !== undefined) return Promise.resolve(saved);
  let request = pending.get(key);
  if (!request) {
    request = (async () => {
      const file: File = await withDeadline(api.messages.getAttachmentFile(message.id, attachment.partName), 8000, undefined, "Inline image");
      const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      memory.set(key, url); return url;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}

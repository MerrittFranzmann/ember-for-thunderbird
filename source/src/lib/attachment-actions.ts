import { api } from "./api";
import type { MessageAttachment } from "./types";

export async function openAttachment(messageId: number, attachment: MessageAttachment) {
  const tab = await api.tabs.getCurrent();
  await api.messages.openAttachment(messageId, attachment.partName, tab.id);
}

/** A name downloads.download accepts: no path separators or characters macOS/Windows reject, no leading dots. */
export function downloadName(name: string | undefined): string {
  const clean = (name || "").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 200);
  return clean || "attachment";
}

/**
 * Save through Thunderbird's download manager with the system Save dialog. An <a download> click
 * does nothing in a Thunderbird extension page (no file, no dialog), which is what 0.1.63 and
 * earlier did. Cancelling the dialog isn't an error.
 */
export async function saveAttachment(messageId: number, attachment: MessageAttachment) {
  const file: File = await api.messages.getAttachmentFile(messageId, attachment.partName);
  await saveFile(file, attachment.name || file.name);
}

/** Save a file the page made or fetched, with the system Save dialog (see saveAttachment). */
export async function saveFile(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  try {
    await api.downloads.download({ url, filename: downloadName(name), saveAs: true });
  } catch (error: any) {
    if (!/cancel/i.test(String(error?.message || error))) throw error;
  } finally {
    // The download reads the blob after download() resolves.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

/** Several attachments straight to the Downloads folder (one Save dialog per file would be a dialog storm);
 *  a name already there gets a number. Returns how many were saved. */
export async function saveAttachmentsToDownloads(messageId: number, attachments: MessageAttachment[]): Promise<number> {
  let saved = 0;
  for (const attachment of attachments) {
    const file: File = await api.messages.getAttachmentFile(messageId, attachment.partName);
    const url = URL.createObjectURL(file);
    try {
      await api.downloads.download({ url, filename: downloadName(attachment.name || file.name), saveAs: false, conflictAction: "uniquify" });
      saved++;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  }
  return saved;
}

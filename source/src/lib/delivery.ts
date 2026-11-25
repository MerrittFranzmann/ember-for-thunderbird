// Sending through Thunderbird, shared by the composer (sends now) and the background's outbox (sends later).
// See compose.svelte.ts for the strategy: new mail goes through messages.sendMessage when Thunderbird allows
// it; replies, forwards and threaded drafts go through Thunderbird's composer, which writes the threading
// headers and attaches forwarded files. (No imports from page modules: the background bundles this file.)

/** Whether an email can go without a compose window (new mail, a draft that isn't a reply). */
export function windowFree(mode: string, threaded: boolean | undefined): boolean {
  return mode === "new" || (mode === "draft" && !threaded);
}

/** Kind of window-free send (sparkSend Experiment) for an email that answers or forwards another, or null. */
export function threadedKind(native: any, mode: string, threaded: boolean | undefined, relatedId: number | undefined): "reply" | "forward" | "draft" | null {
  if (typeof native?.sparkSend?.send !== "function" || relatedId === undefined) return null;
  if (mode === "reply" || mode === "replyAll") return "reply";
  if (mode === "forward") return "forward";
  if (mode === "draft" && threaded) return "draft";
  return null;
}

/** The Experiment's answer for a forward whose attachments only Thunderbird's composer can carry over. */
export const needsComposer = (error: any) => /needs Thunderbird's composer/.test(String(error?.message || error));

/**
 * Sends a reply, reply draft or forward without Thunderbird's composer window when it can (null: it can't,
 * use the composer). Replies through the composer showed its window, and one sent later popped up over the
 * user's work (2026-11-13).
 */
export async function sendThreaded(native: any, mode: string, relatedId: number | undefined, det: any, threaded: boolean | undefined): Promise<{ headerMessageId?: string } | null> {
  const kind = threadedKind(native, mode, threaded, relatedId);
  if (!kind) return null;
  try {
    return await native.sparkSend.send(det, { kind, relatedId });
  } catch (error) {
    if (needsComposer(error)) return null;
    throw error;
  }
}

/** Thunderbird's composer for an email, minimized (when asked) before anything else can open a dialog. */
export async function openComposeTab(native: any, mode: string, relatedId: number | undefined, det: any, threaded: boolean | undefined, minimize: boolean): Promise<any> {
  let tab: any;
  if ((mode === "reply" || mode === "replyAll") && relatedId !== undefined) {
    tab = await native.compose.beginReply(relatedId, mode === "replyAll" ? "replyToAll" : "replyToSender", det);
  } else if (mode === "forward" && relatedId !== undefined) {
    tab = await native.compose.beginForward(relatedId, "forwardInline", det);
  } else if (mode === "draft" && threaded && relatedId !== undefined) {
    // Thunderbird reopens the draft with its In-Reply-To and References.
    tab = await native.compose.beginNew(relatedId, det);
  } else {
    tab = await native.compose.beginNew(det);
  }
  if (minimize && tab?.windowId) await native.windows.update(tab.windowId, { state: "minimized" }).catch(() => {});
  return tab;
}

export async function closeComposeTab(native: any, tab: any) {
  if (!tab) return;
  try { await native.compose.setComposeDetails(tab.id, { isModified: false }); } catch { /* older TB */ }
  try { await native.tabs.remove(tab.id); } catch { /* already closed */ }
}

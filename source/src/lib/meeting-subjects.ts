// Meeting subjects ("Accepted: X", "Updated invitation: X @ …"). No calendar parsing here:
// the list's conversation grouping uses these for every message.

export type Response = "ACCEPTED" | "TENTATIVE" | "DECLINED";
const RESPONSE_WORDS: Record<string, Response> = { accepted: "ACCEPTED", declined: "DECLINED", tentative: "TENTATIVE", "tentatively accepted": "TENTATIVE" };
// Google appends " @ Wed Oct 28, 2026 1pm - 2pm (EDT) (who@example.org)" to the title.
const stripGoogleWhen = (title: string) => title.replace(/\s@\s(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*|Weekly|Daily|Monthly|Annually|Every)\b.*$/i, "").trim();
/** "Accepted: Team sync" → the response and the meeting title; null for any other subject. */
export function responseSubject(subject: string): { response: Response; title: string } | null {
  const match = /^(accepted|declined|tentative|tentatively accepted)(?: with comment)?\s*:\s*(.+)$/i.exec((subject || "").trim());
  return match ? { response: RESPONSE_WORDS[match[1].toLowerCase()], title: stripGoogleWhen(match[2]) } : null;
}
/** "2 accepted · 1 maybe · 1 declined" for a set of response subjects. */
export function responseTally(subjects: string[]): string {
  const counts: Record<Response, number> = { ACCEPTED: 0, TENTATIVE: 0, DECLINED: 0 };
  for (const subject of subjects) { const parsed = responseSubject(subject); if (parsed) counts[parsed.response]++; }
  return ([["ACCEPTED", "accepted"], ["TENTATIVE", "maybe"], ["DECLINED", "declined"]] as const).filter(([key]) => counts[key]).map(([key, word]) => `${counts[key]} ${word}`).join(" · ");
}
/** The meeting title in an invitation subject ("Updated invitation: X @ …", "FW: X"). */
export function inviteTitle(subject: string): string {
  let title = (subject || "").trim(), previous = "";
  while (title !== previous) { previous = title; title = title.replace(/^(?:(?:updated )?invitation(?: with note)?|updated(?: event)?|fwd?|fw)\s*:\s*/i, ""); }
  return stripGoogleWhen(title);
}

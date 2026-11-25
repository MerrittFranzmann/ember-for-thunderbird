// Address autocomplete: Thunderbird address books (addressBooks.contacts.query,
// TB 127+, vCard nodes in MV3) merged with recent correspondents from loaded mail.

import { api, env } from "./api";
import { store } from "./store.svelte";

export interface Suggestion {
  name: string;
  email: string;
  source: "contact" | "recent";
}

function unfold(vcard: string): string[] {
  return vcard.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

/** Extract FN + EMAIL values from a vCard string. */
export function parseVCard(vcard: string): { name: string; emails: string[] } {
  let name = "";
  const emails: string[] = [];
  for (const line of unfold(vcard)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).split(";")[0].toUpperCase().replace(/^ITEM\d+\./, "");
    const val = line.slice(i + 1).replace(/\\,/g, ",").replace(/\\;/g, ";").trim();
    if (key === "FN" && !name) name = val;
    else if (key === "EMAIL" && val) emails.push(val);
    else if (key === "N" && !name) {
      const [last, first] = val.split(";");
      name = [first, last].filter(Boolean).join(" ");
    }
  }
  return { name, emails };
}

export async function suggest(q: string, exclude: Set<string>): Promise<Suggestion[]> {
  const query = q.trim();
  const out: Suggestion[] = [];
  const seen = new Set(exclude);
  if (query.length >= 1 && env.hasContactsQuery) {
    try {
      const nodes = await api.addressBooks.contacts.query({ searchString: query });
      for (const n of nodes.slice(0, 20)) {
        const v = parseVCard(n.vCard || "");
        for (const e of v.emails) {
          const k = e.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ name: v.name, email: e, source: "contact" });
        }
      }
    } catch {
      /* address books unavailable */
    }
  }
  for (const r of store.recentCorrespondents(query, 8)) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    out.push({ ...r, source: "recent" });
  }
  return out.slice(0, 8);
}

import { describe, expect, it, vi } from "vitest";
import { TravelService } from "../src/lib/travel-service";
import type { MessageHeader } from "../src/lib/types";

const inbox = { id: "in", accountId: "a", name: "Inbox", path: "/INBOX", specialUse: ["inbox"] };
const header = (id: number, author: string, subject: string, date = new Date()): MessageHeader => ({ id, author, subject, date, headerMessageId: `<m${id}@x>`, folder: inbox, recipients: [], ccList: [], bccList: [], flagged: false, size: 1, tags: [] } as any);
const soon = (hours: number) => { const d = new Date(Date.now() + hours * 3600000); return d.toISOString().slice(0, 16); };
const flight = (gate: string, status = "confirmed") => ({ result: { response: { bookings: [{ kind: "flight", status, number: "TP 1351", from_code: "JFK", to_code: "LIS", gate, start_local: soon(30), start_timezone: "UTC", end_local: soon(37), end_timezone: "UTC" }, { kind: "hotel", status: "confirmed", name: "Casa do Rio", city: "Lisbon", start_local: soon(40), start_timezone: "UTC", end_local: soon(120), end_timezone: "UTC" }] } } });
const TEXT = "Flight TP 1351 departs JFK Terminal 1, gate B12, seat 14C. Confirmation QX7P2L.";

function setup(mail: MessageHeader[], bodies: Record<number, string>, settings: any = { aiSort: true, clefAccount: "0123456789abcdef0123456789abcdef", clefToken: "t".repeat(40) }) {
  const store: Record<string, any> = { ...settings };
  const native: any = {
    storage: { local: { get: vi.fn(async (d: any) => { const out: any = {}; for (const k of typeof d === "string" ? [d] : Object.keys(d)) out[k] = k in store ? store[k] : d[k]; return out; }), set: vi.fn(async (v: any) => Object.assign(store, v)) } },
    accounts: { list: vi.fn(async () => [{ identities: [{ email: "me@northwind.example" }] }]) },
    sparkAI: { llm: vi.fn(async () => ({ status: 200, body: flight("B12") })) },
    alarms: { getAll: vi.fn(async () => []), create: vi.fn(async () => {}), clear: vi.fn(async () => true) },
    notifications: { create: vi.fn(async () => ""), clear: vi.fn(async () => true) },
  };
  const open = vi.fn(async () => {});
  const service = new TravelService(native, { headers: async () => mail, full: async (m) => ({ contentType: "text/plain", headers: {}, body: bodies[m.id] } as any) }, open);
  return { native, store, service, open };
}

describe("the background's trips", () => {
  it("reads only travel mail, once each, with markup first and Workers AI for the rest", async () => {
    const markup = `<script type="application/ld+json">{"@context":"http://schema.org","@type":"LodgingReservation","reservationNumber":"H1","checkinDate":"${soon(50)}:00Z","checkoutDate":"${soon(90)}:00Z","reservationFor":{"name":"Hotel X","address":{"addressLocality":"Porto"}}}</script>`;
    const mail = [header(1, "TAP <noreply@flytap.com>", "Your booking"), header(2, "Ada <ada@x.org>", "Lunch?"), header(3, "Deals <d@flytap.com>", "Fly for $99"), header(4, "Hotels <h@marriott.com>", "Reservation")];
    const { native, store, service } = setup(mail, { 1: TEXT, 3: "Sale! Lisbon from $99.", 4: "" });
    (service as any).source.full = async (m: MessageHeader) => m.id === 4 ? { contentType: "text/html", headers: {}, body: markup } : { contentType: "text/plain", headers: {}, body: { 1: TEXT, 3: "Sale! Lisbon from $99." }[m.id as 1 | 3] };
    await service.run();
    expect(native.sparkAI.llm).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(Object.entries(store.travelAnswers).map(([k, r]: any) => [k, [r.src, r.b.length]]))).toEqual({ "m1@x": ["ai", 2], "m3@x": ["none", 0], "m4@x": ["markup", 1] });
    expect(store.travelBookings.map((b: any) => b.kind)).toEqual(["flight", "hotel", "hotel"]);
    expect(store.travelStatus).toMatchObject({ state: "idle", checked: 3, trips: 1 });
    expect(native.alarms.create).toHaveBeenCalledWith("spark-travel-checkin:" + store.travelBookings[0].key, expect.objectContaining({ when: expect.any(Number) }));
    await service.run();
    expect(native.sparkAI.llm).toHaveBeenCalledTimes(1);
  });
  it("without AI, keeps travel mail for later, and asks once AI sorting is on", async () => {
    const mail = [header(1, "TAP <noreply@flytap.com>", "Your booking")];
    const { native, store, service } = setup(mail, { 1: TEXT }, {});
    await service.run();
    expect(store.travelAnswers["m1@x"].src).toBe("noai");
    expect(native.sparkAI.llm).not.toHaveBeenCalled();
    Object.assign(store, { aiSort: true, clefAccount: "0123456789abcdef0123456789abcdef", clefToken: "t".repeat(40) });
    await service.run();
    expect(store.travelAnswers["m1@x"].src).toBe("ai");
  });
  it("announces a gate change from a new email, and opens the trip from the notification", async () => {
    const mail = [header(1, "TAP <noreply@flytap.com>", "Your booking", new Date(Date.now() - 86400000))];
    const { native, service, open } = setup(mail, { 1: TEXT, 2: TEXT.replace("B12", "B27") });
    await service.run();
    expect(native.notifications.create).not.toHaveBeenCalled();
    mail.push(header(2, "TAP <noreply@flytap.com>", "Gate change for TP 1351"));
    native.sparkAI.llm.mockResolvedValueOnce({ status: 200, body: flight("B27") });
    await service.run();
    expect(native.notifications.create).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^spark-trip:lisbon-/), expect.objectContaining({ title: "Gate changed: TP 1351 now leaves from B27" }));
    const id = native.notifications.create.mock.calls[0][0];
    expect(await service.clicked(id)).toBe(true);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^lisbon-/));
    expect(await service.clicked("spark-mail:1")).toBe(false);
  });
  it("stops on a refused token and retries later after a rate limit", async () => {
    const mail = [header(1, "TAP <noreply@flytap.com>", "Your booking"), header(2, "TAP <noreply@flytap.com>", "Your flight")];
    const { native, store, service } = setup(mail, { 1: TEXT, 2: TEXT });
    native.sparkAI.llm.mockResolvedValue({ status: 429, body: null });
    await service.run();
    expect(native.sparkAI.llm).toHaveBeenCalledTimes(1);
    expect(store.travelStatus.state).toBe("error");
    expect(store.travelAnswers).toEqual({});
  });
});

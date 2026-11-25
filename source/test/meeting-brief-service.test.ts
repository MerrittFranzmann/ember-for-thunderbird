import { describe, expect, it, vi } from "vitest";
import { ReminderService } from "../src/lib/reminder-service";
import type { MessageHeader } from "../src/lib/types";

function fakeNative(events: any[], settings: Record<string, any> = {}) {
  const store: Record<string, any> = { meetingReminder: 0, ...settings };
  const alarms = new Map<string, any>();
  return {
    store, scheduled: alarms,
    storage: { local: {
      get: vi.fn(async (defaults: Record<string, any>) => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, k in store ? store[k] : v]))),
      set: vi.fn(async (values: Record<string, any>) => { Object.assign(store, values); }),
    } },
    alarms: { get: vi.fn(async (name: string) => alarms.get(name)), getAll: vi.fn(async () => [...alarms.values()]), create: vi.fn(async (name: string, info: any) => { alarms.set(name, { name, ...info }); }), clear: vi.fn(async (name: string) => alarms.delete(name)) },
    notifications: { create: vi.fn(async () => "id"), clear: vi.fn(async () => true) },
    accounts: { list: vi.fn(async () => [{ identities: [{ email: "Me@northwind.example" }] }]) },
    sparkCalendar: { calendarView: vi.fn(async () => ({ accounts: 1, errors: [], events })) },
  };
}
const inMinutes = (n: number) => new Date(Date.now() + n * 60000).toISOString();
const meeting = (start: number, uid = "M") => ({ accountId: "a", id: uid, uid, subject: "Studio sync", start: inMinutes(start), end: inMinutes(start + 30), allDay: false, location: "", freeBusy: "Busy", response: "accept", cancelled: false, body: "",
  attendees: [{ name: "Ada Lovelace", email: "ada@partner.org" }, { name: "Me", email: "me@northwind.example" }] });
const mail = (author: string): MessageHeader => ({ id: 1, date: new Date(), author, subject: "Plan", flagged: false, recipients: ["me@northwind.example"], ccList: [], bccList: [], headerMessageId: "m", size: 1, tags: [] });

describe("before your meeting: the background notification", () => {
  it("sets an alarm ten minutes before, and notifies then with the recent email", async () => {
    const native = fakeNative([meeting(40)]);
    const service = new ReminderService(native, vi.fn(), async () => [mail("Ada Lovelace <ada@partner.org>"), mail("other@else.org")]);
    await service.refresh();
    const [alarm] = [...native.scheduled.values()].filter((a) => a.name.startsWith("spark-brief:"));
    expect(alarm.when).toBeGreaterThan(Date.now() + 29 * 60000);
    expect(native.notifications.create).not.toHaveBeenCalled();
    await service.alarm(alarm.name);
    expect(native.notifications.create).toHaveBeenCalledWith(alarm.name, expect.objectContaining({ title: "Before Studio sync", message: expect.stringContaining("1 recent email with Ada Lovelace. Click to see them.") }));
    // Once per meeting.
    await service.alarm(alarm.name);
    expect(native.notifications.create).toHaveBeenCalledOnce();
  });
  it("notifies at once for a meeting starting within ten minutes, and not at all without recent email", async () => {
    const native = fakeNative([meeting(6, "soon"), meeting(7, "quiet")]);
    const service = new ReminderService(native, vi.fn(), async () => [mail("ada@partner.org")]);
    native.sparkCalendar.calendarView.mockResolvedValueOnce({ accounts: 1, errors: [], events: [meeting(6, "soon")] });
    await service.refresh();
    expect(native.notifications.create).toHaveBeenCalledOnce();
    const none = fakeNative([meeting(6)]);
    await new ReminderService(none, vi.fn(), async () => []).refresh();
    expect(none.notifications.create).not.toHaveBeenCalled();
  });
  it("opens the brief in Ember when clicked, and stays off when turned off", async () => {
    const native = fakeNative([meeting(40)]);
    const open = vi.fn(async () => {});
    const service = new ReminderService(native, open, async () => [mail("ada@partner.org")]);
    await service.refresh();
    const key = Object.keys(native.store.briefPlan)[0];
    expect(await service.clicked(`spark-brief:${key}`)).toBe(true);
    expect(native.store.sparkOpenBrief.brief).toMatchObject({ key, subject: "Studio sync", people: [{ email: "ada@partner.org" }] });
    expect(open).toHaveBeenCalled();
    const off = fakeNative([meeting(40)], { meetingBrief: false });
    await new ReminderService(off, vi.fn(), async () => [mail("ada@partner.org")]).refresh();
    expect([...off.scheduled.keys()].some((name) => name.startsWith("spark-brief:"))).toBe(false);
  });
});

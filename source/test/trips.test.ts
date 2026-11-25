import { describe, expect, it } from "vitest";
import { buildTrips, changeText, checkInTimes, currentTrips, dayKey, localInstant, markupBookings, mergeBookings, pinnedChanges, rightNow, timeText, timeline, travelAnswer, travelHint, travelRequest, travelText, tripDay, untilText, type Booking } from "../src/lib/trips";

const Z = (iso: string) => Date.parse(iso);
const ai = (bookings: any[]) => ({ result: { response: { bookings } } });
const LISBON = [
  { kind: "flight", status: "confirmed", provider: "TAP Air Portugal", number: "TP1351", from_code: "JFK", from_city: "New York", to_code: "LIS", to_city: "Lisbon", confirmation: "QX7P2L", seat: "14C", gate: "B12", start_local: "2026-11-02T19:55", start_timezone: "America/New_York", end_local: "2026-11-03T07:50", end_timezone: "Europe/Lisbon" },
  { kind: "hotel", status: "confirmed", name: "Casa do Rio Hotel", address: "Rua das Flores 41, 1200-193 Lisboa", city: "Lisbon", confirmation: "CR-48213", start_local: "2026-11-03T15:00", start_timezone: "Europe/Lisbon", end_local: "2026-11-07T11:00", end_timezone: "Europe/Lisbon" },
  { kind: "car", status: "confirmed", provider: "Atlântico", name: "Terminal 1 desk", start_local: "2026-11-06T09:00", start_timezone: "Europe/Lisbon", end_local: "2026-11-07T10:00", end_timezone: "Europe/Lisbon" },
  { kind: "event", status: "confirmed", name: "Film Forum walkthrough", address: "LX Factory, Rua Rodrigues de Faria 103", start_local: "2026-11-04T10:00", start_timezone: "Europe/Lisbon" },
  { kind: "flight", status: "confirmed", number: "TP 207", from_code: "LIS", to_code: "JFK", start_local: "2026-11-07T14:45", start_timezone: "Europe/Lisbon", end_local: "2026-11-07T17:30", end_timezone: "America/New_York" },
];

describe("times in the place's own zone", () => {
  it("turns local times into instants across zones and daylight saving", () => {
    expect(localInstant("2026-11-02T19:55", "America/New_York")!.at).toBe(Z("2026-11-03T00:55:00Z")); // EST, after Nov 1
    expect(localInstant("2026-10-31T19:55", "America/New_York")!.at).toBe(Z("2026-10-31T23:55:00Z")); // still EDT
    expect(localInstant("2026-11-03T07:50", "Europe/Lisbon")!.at).toBe(Z("2026-11-03T07:50:00Z"));
    expect(localInstant("2026-11-03T07:50:00+01:00")).toEqual({ at: Z("2026-11-03T06:50:00Z"), offset: 60 });
    expect(localInstant("2026-11-03", "Europe/Lisbon")!.at).toBe(Z("2026-11-03T00:00:00Z"));
    expect(localInstant("next Tuesday", "Europe/Lisbon")).toBeNull();
    expect(localInstant("2026-11-03T07:50", "Mars/Olympus")!.tz).toBeUndefined();
  });
  it("shows a clock in its zone", () => {
    const c = localInstant("2026-11-02T19:55", "America/New_York")!;
    expect(timeText(c)).toBe("7:55 PM");
    expect(timeText({ at: c.at, tz: "Europe/Lisbon" })).toBe("12:55 AM");
    expect(dayKey({ at: c.at, tz: "Europe/Lisbon" })).toBe("2026-11-03");
    expect(timeText({ at: Z("2026-11-03T06:50:00Z"), offset: 60 })).toBe("7:50 AM");
  });
});

describe("finding bookings", () => {
  it("looks closer only at likely travel mail, and at text with booking details", () => {
    expect(travelHint("TAP <noreply@flytap.com>", "Your booking")).toBe(true);
    expect(travelHint("Ada <ada@x.org>", "Your flight to Lisbon")).toBe(true);
    expect(travelHint("Ada <ada@x.org>", "Lunch?")).toBe(false);
    expect(travelText("Flight TP 1351 departs JFK Terminal 1 at 7:55 PM")).toBe(true);
    expect(travelText("Check-in: Nov 3 from 3 PM. Check-out: Nov 7 by 11 AM.")).toBe(true);
    expect(travelText("Fly to Lisbon from $399! Deals end Sunday.")).toBe(false);
    expect(travelText("Your table for 4 at Taberna Alfama is confirmed: Tue 8:30 PM.")).toBe(true);
    expect(travelText("Your tickets are confirmed. Lisbon Film Forum, Nov 4.")).toBe(true);
  });
  it("reads schema.org markup", () => {
    const html = `<script type="application/ld+json">[{"@context":"http://schema.org","@type":"FlightReservation","reservationNumber":"QX7P2L","reservationStatus":"http://schema.org/Confirmed","airplaneSeat":"14C",
      "reservationFor":{"@type":"Flight","flightNumber":"1351","airline":{"@type":"Airline","name":"TAP","iataCode":"TP"},"departureAirport":{"@type":"Airport","iataCode":"JFK"},"departureTime":"2026-11-02T19:55:00-05:00","departureGate":"B12",
      "arrivalAirport":{"@type":"Airport","iataCode":"LIS","name":"Lisbon Airport"},"arrivalTime":"2026-11-03T07:50:00+00:00"}},
      {"@type":"LodgingReservation","reservationNumber":"CR-48213","checkinDate":"2026-11-03T15:00:00+00:00","checkoutDate":"2026-11-07T11:00:00+00:00","reservationFor":{"@type":"LodgingBusiness","name":"Casa do Rio","address":{"streetAddress":"Rua das Flores 41","addressLocality":"Lisbon","postalCode":"1200-193","addressCountry":"PT"}}}]</script>`;
    const [flight, hotel] = markupBookings(html, "m1");
    expect(flight).toMatchObject({ kind: "flight", number: "TP 1351", provider: "TAP", gate: "B12", seat: "14C", confirmation: "QX7P2L", from: { code: "JFK" }, to: { code: "LIS" }, start: { at: Z("2026-11-03T00:55:00Z"), offset: -300 } });
    expect(hotel).toMatchObject({ kind: "hotel", name: "Casa do Rio", city: "Lisbon", address: "Rua das Flores 41, 1200-193 Lisbon, PT", key: "hotel|cr48213" });
    expect(markupBookings("<p>no markup</p>", "m")).toEqual([]);
  });
  it("asks Workers AI for structured bookings and reads its answer (object or text)", () => {
    const request = travelRequest({ from: "TAP <a@flytap.com>", subject: "Your trip", date: "2026-10-01", text: "x".repeat(9000) });
    expect(request.response_format.type).toBe("json_schema");
    expect(request.messages[1].content.length).toBeLessThan(6200);
    const bookings = travelAnswer(ai(LISBON), "m1")!;
    expect(bookings.map((b) => b.kind)).toEqual(["flight", "hotel", "car", "event", "flight"]);
    expect(bookings[0]).toMatchObject({ number: "TP 1351", key: "flight|tp1351|2026-11-02", end: { tz: "Europe/Lisbon" } });
    expect(travelAnswer({ result: { response: JSON.stringify({ bookings: [LISBON[1]] }) } }, "m")).toHaveLength(1);
    expect(travelAnswer(ai([{ kind: "spaceship", start_local: "2026-11-01" }, { kind: "hotel", start_local: "soon" }]), "m")).toEqual([]);
    expect(travelAnswer({ result: { response: "not json" } }, "m")).toBeNull();
  });
});

describe("trips", () => {
  const booked = travelAnswer(ai(LISBON), "m1")!;
  const gate = travelAnswer(ai([{ ...LISBON[0], status: "changed", gate: "B27" }]), "m2")!;
  const bookings = mergeBookings([{ mid: "m2", date: Z("2026-11-02T23:31:00Z"), bookings: gate }, { mid: "m1", date: Z("2026-10-01T12:00:00Z"), bookings: booked }]);
  const local = travelAnswer(ai([{ kind: "restaurant", name: "Dinner at home", start_local: "2026-11-20T19:00", start_timezone: "America/New_York" }]), "m3")!;
  const trips = buildTrips([...bookings, ...local], Z("2026-10-29T12:00:00Z"), "America/New_York");
  const [trip] = trips;
  it("merges a later change into the booking and remembers what it was", () => {
    const flight = bookings[0];
    expect(flight).toMatchObject({ gate: "B27", was: { gate: "B12" }, mid: "m2", mids: ["m1", "m2"], seat: "14C" });
    expect(changeText(flight)).toBe("Gate changed: TP 1351 now leaves from B27");
    const later = mergeBookings([{ mid: "a", date: 1, bookings: [booked[0]] }, { mid: "b", date: 2, bookings: travelAnswer(ai([{ ...LISBON[0], start_local: "2026-11-02T21:10" }]), "b")! }])[0];
    expect(changeText(later)).toBe("TP 1351 now leaves at 9:10 PM");
  });
  it("groups the bookings into one trip named after where you stay; a dinner at home isn't a trip", () => {
    expect(trips).toHaveLength(1);
    expect(trip).toMatchObject({ city: "Lisbon", tz: "Europe/Lisbon", phase: "upcoming", mids: ["m1", "m2"], id: "lisbon-2026-11-02" });
    expect(trip.end.at).toBe(Z("2026-11-07T22:30:00Z"));
    expect(untilText(trip.start.at, Z("2026-10-29T12:00:00Z"), "America/New_York")).toBe("in 4 days");
    expect(currentTrips(trips, Z("2026-12-20T00:00:00Z"))).toEqual([]);
  });
  it("lays the trip out by local day", () => {
    const days = timeline(trip);
    expect(days.map((d) => [d.key, d.items.map((i) => i.label)])).toEqual([
      ["2026-11-02", ["Flight TP 1351 · JFK → LIS"]],
      ["2026-11-03", ["Land in Lisbon", "Check in, Casa do Rio Hotel"]],
      ["2026-11-04", ["Film Forum walkthrough"]],
      ["2026-11-06", ["Car pick-up, Atlântico"]],
      ["2026-11-07", ["Car drop-off, Atlântico", "Check out, Casa do Rio Hotel", "Flight TP 207 · LIS → JFK", "Land in JFK"]],
    ]);
  });
  it("knows what matters right now: the flight, then the hotel on arrival, then the meeting", () => {
    const at = (iso: string) => rightNow(trip, Z(iso)).map((c) => `${c.moment}:${c.booking.kind}`);
    expect(at("2026-11-02T22:40:00Z")).toEqual(["flight:flight"]); // 6:40 PM at JFK
    expect(at("2026-11-03T08:20:00Z")).toEqual(["arrival:hotel"]); // landed
    expect(at("2026-11-04T09:20:00Z")).toEqual(["event:event"]); // 40 min before
    expect(at("2026-11-05T12:00:00Z")).toEqual([]);
    expect(at("2026-11-07T08:00:00Z")).toEqual(["checkout:hotel", "flight:flight"]); // last morning
    expect(at("2026-11-06T01:00:00Z")).toEqual(["car:car"]);
    expect(pinnedChanges(trip, Z("2026-11-02T23:40:00Z")).map((b) => b.number)).toEqual(["TP 1351"]);
    expect(tripDay(trip, Z("2026-11-04T09:20:00Z"))).toBe(2);
    expect(tripDay(trip, Z("2026-11-03T08:20:00Z"))).toBe(1); // landed
    expect(tripDay(trip, Z("2026-11-03T01:00:00Z"))).toBe(0); // in the air, already the 3rd in Lisbon
    expect(buildTrips(bookings, Z("2026-11-02T22:40:00Z"))[0].phase).toBe("now"); // at the airport
    expect(buildTrips(bookings, Z("2026-11-02T08:00:00Z"))[0].phase).toBe("upcoming");
    expect(checkInTimes(trip.bookings, Z("2026-10-29T12:00:00Z")).map((c) => c.at)).toEqual([Z("2026-11-02T00:55:00Z"), Z("2026-11-06T14:45:00Z")]);
  });
  it("leaves cancelled bookings out of what's next, and says so", () => {
    const cancelled = mergeBookings([{ mid: "a", date: 1, bookings: [booked[0]] }, { mid: "b", date: 2, bookings: travelAnswer(ai([{ ...LISBON[0], status: "cancelled" }]), "b")! }]);
    expect(changeText(cancelled[0])).toBe("TP 1351 was cancelled");
    const t = buildTrips([...cancelled, booked[1]], Z("2026-11-02T22:40:00Z"))[0];
    expect(rightNow(t, Z("2026-11-02T22:40:00Z"))).toEqual([]);
  });
  it("ignores bookings without a trip, like a lone restaurant", () => {
    expect(buildTrips(local as Booking[], 0)).toEqual([]);
  });
});

describe("the trip's receipts", async () => {
  const { tripReceipt } = await import("../src/lib/trip-view");
  it("are rides, travel companies, the trip's own bookings, or name its city", () => {
    const trip = { city: "Lisbon", bookings: [{ kind: "car", provider: "Atlântico Car Rental", name: "Terminal 1 desk" }, { kind: "hotel", name: "Casa do Rio Hotel" }] } as any;
    expect(tripReceipt({ author: "Uber Receipts <noreply@uber.com>", subject: "Your trip with Uber" }, trip)).toBe(true);
    expect(tripReceipt({ author: "Atlantico <r@atlantico.pt>", subject: "Your receipt for ATL-7731" }, trip)).toBe(true);
    expect(tripReceipt({ author: "Casa do Rio <f@casadorio.pt>", subject: "Your invoice" }, trip)).toBe(true);
    expect(tripReceipt({ author: "Pastelaria <x@y.pt>", subject: "Receipt: Lisboa café" }, trip)).toBe(false);
    expect(tripReceipt({ author: "Apple <no_reply@email.apple.com>", subject: "Your receipt from Apple." }, trip)).toBe(false);
    expect(tripReceipt({ author: "Stripe <receipts@stripe.com>", subject: "Your receipt from Acme Studio #720" }, trip)).toBe(false);
  });
});

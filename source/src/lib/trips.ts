// Trips: travel bookings found in mail (flights, hotels, cars, trains, events) grouped into trips, with what
// matters right now. Bookings come from the email's schema.org markup when it has some (markupBookings), else
// from Workers AI (travelRequest/travelAnswer; the background's TravelService asks once per email). Times keep
// the place's time zone so the trip shows local time with home time underneath. Pure; unit-tested
// (test/trips.test.ts). No page imports: the background bundles this file.

export type BookingKind = "flight" | "hotel" | "car" | "train" | "event" | "restaurant";
export interface Clock { at: number; tz?: string; offset?: number }
export interface Place { code?: string; city?: string; name?: string }
export interface Booking {
  key: string;
  kind: BookingKind;
  status: "confirmed" | "cancelled";
  /** Airline, hotel, rental company, venue. */
  provider?: string;
  /** Flight or train number ("TP 1351"). */
  number?: string;
  /** Hotel, venue or restaurant name. */
  name?: string;
  from?: Place;
  to?: Place;
  address?: string;
  city?: string;
  confirmation?: string;
  seat?: string;
  gate?: string;
  terminal?: string;
  start: Clock;
  end?: Clock;
  /** The email it came from (latest), and every email about it. */
  mid: string;
  mids: string[];
  /** What a later email changed (the earlier values), and when. */
  was?: { gate?: string; start?: Clock; status?: string };
  changedAt?: number;
}

// ---------------------------------------------------------------- time zones

function zoneParts(at: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(at))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
}
export function validZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/** "2026-11-03T07:50" in Europe/Lisbon → the instant. An address with its own offset wins; no zone: this Mac's. */
export function localInstant(local: string, tz?: string): Clock | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(String(local || "").trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", zone] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!Number.isFinite(wall)) return null;
  if (zone) {
    const offset = zone === "Z" ? 0 : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
    return { at: wall - offset * 60000, ...(validZone(tz) ? { tz } : { offset }) };
  }
  if (validZone(tz)) {
    let at = wall - (zoneParts(wall, tz) - wall);
    at = wall - (zoneParts(at, tz) - at); // again, across a daylight-saving change
    return { at, tz };
  }
  return { at: new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime() };
}
/** Format options in the clock's own zone (or fixed offset, or this Mac's). */
function zoned(clock: Clock, options: Intl.DateTimeFormatOptions, locale = "en-US"): string {
  if (clock.tz) return new Intl.DateTimeFormat(locale, { ...options, timeZone: clock.tz }).format(new Date(clock.at));
  if (clock.offset !== undefined) return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(clock.at + clock.offset * 60000));
  return new Intl.DateTimeFormat(locale, options).format(new Date(clock.at));
}
export const timeText = (clock: Clock) => zoned(clock, { hour: "numeric", minute: "2-digit" });
export const dayText = (clock: Clock) => zoned(clock, { weekday: "short", month: "short", day: "numeric" });
/** The clock's local date, "2026-11-03". */
export const dayKey = (clock: Clock) => zoned(clock, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA");
/** Whether a clock's place keeps a different time from home now. */
export function otherZone(clock: Clock, homeTz: string): boolean {
  const here = zoned({ ...clock }, { hour: "numeric", minute: "2-digit", day: "numeric" });
  return here !== zoned({ at: clock.at, tz: homeTz }, { hour: "numeric", minute: "2-digit", day: "numeric" });
}
/** "Lisbon" from "Europe/Lisbon". */
export const zoneCity = (tz?: string) => (tz?.split("/").pop() || "").replace(/_/g, " ");

// ---------------------------------------------------------------- finding travel mail

const TRAVEL_SUBJECT = /\b(flights?|itinerary|boarding pass|e-?ticket|check[- ]?in|reservation|booking|booked|confirmation|confirmed|hotel|stay|rental car|car rental|gate|delay(?:ed)?|cancell?ed|trip|travel|departure|your (?:upcoming )?(?:trip|flight|stay)|train|amtrak|seat)\b/i;
const TRAVEL_SENDERS = /(?:^|[.@])(?:expedia|booking|airbnb|hotels|marriott|hilton|hyatt|ihg|accor|wyndham|choicehotels|bestwestern|vrbo|delta|united|aa|americanairlines|southwest|southwestairlines|jetblue|alaskaair|spirit|flyfrontier|hawaiianairlines|aircanada|westjet|britishairways|ba|lufthansa|klm|airfrance|flytap|tap|iberia|emirates|qatarairways|turkishairlines|ryanair|easyjet|skiplagged|kayak|priceline|orbitz|travelocity|hopper|tripit|concur|navan|egencia|amexgbt|hertz|enterprise|avis|budget|nationalcar|alamo|sixt|turo|amtrak|eurostar|trainline|sncf-connect|ticketmaster|eventbrite|opentable|resy)\.(?:com|net|co\.uk|de|fr|pt|org|ca)\b/i;
/** A cheap first look: could this email be about a booked trip? (Subject or sender only.) */
export function travelHint(author: string, subject: string): boolean {
  const address = (/<([^>]+)>/.exec(author)?.[1] || author).toLowerCase();
  return TRAVEL_SENDERS.test(address) || TRAVEL_SUBJECT.test(subject || "");
}
/** A closer look at the text: booking details, not an ad. */
export function travelText(text: string): boolean {
  const t = text.slice(0, 8000);
  const flight = /\b(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{1,4}\b/.test(t) && /\b(?:depart|arriv|terminal|gate|boarding|seat)/i.test(t);
  const stay = /\bcheck[- ]?in\b/i.test(t) && /\bcheck[- ]?out\b/i.test(t);
  const code = /\b(?:confirmation|booking|reservation|record locator|itinerary)\s*(?:number|no\.?|code|#|id)?\s*[:#]?\s*[A-Z0-9]{5,}\b/i.test(t);
  const car = /\bpick[- ]?up\b/i.test(t) && /\b(?:drop[- ]?off|return)\b/i.test(t) && /\b(?:car|vehicle|rental)\b/i.test(t);
  // A table or tickets booked (restaurants, events): a reservation or ticket that says it's confirmed.
  const booked = /\b(?:reservation|booking|tickets?|table for \d+)\b/i.test(t) && /\bconfirm(?:ed|ation)\b/i.test(t);
  return flight || stay || car || booked || (code && /\b(?:flight|hotel|stay|train|rental|ticket)\b/i.test(t));
}

// ---------------------------------------------------------------- schema.org markup

const MARKUP_KINDS: Record<string, BookingKind> = { FlightReservation: "flight", LodgingReservation: "hotel", RentalCarReservation: "car", TrainReservation: "train", BusReservation: "train", EventReservation: "event", FoodEstablishmentReservation: "restaurant" };
const typeName = (t: unknown) => String(Array.isArray(t) ? t[0] : t || "").replace(/^https?:\/\/schema\.org\//, "");
const str = (v: unknown): string | undefined => { const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""; return s || undefined; };
const placeOf = (v: any): Place | undefined => {
  if (!v) return undefined;
  const city = str(v.address?.addressLocality) || str(v.addressLocality);
  const p: Place = { code: str(v.iataCode), name: str(v.name), city };
  return p.code || p.name || p.city ? p : undefined;
};
const addressOf = (v: any): string | undefined => {
  const a = v?.address ?? v;
  if (typeof a === "string") return a.trim() || undefined;
  const parts = [a?.streetAddress, [a?.postalCode, a?.addressLocality].filter(Boolean).join(" "), a?.addressRegion, typeof a?.addressCountry === "string" ? a.addressCountry : a?.addressCountry?.name].map(str).filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
};
const clockOf = (v: unknown) => { const s = str(v); return s ? localInstant(s) : null; };

/** Reservations in the email's JSON-LD (as airlines, hotels and booking sites send them for Gmail). */
export function markupBookings(html: string | undefined, mid: string): Booking[] {
  if (!html || !/schema\.org/i.test(html) || !/Reservation/.test(html)) return [];
  const items: any[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const json = JSON.parse(m[1].replace(/&quot;/g, '"').trim()); const walk = (v: any) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (MARKUP_KINDS[typeName(v["@type"])]) items.push(v); if (v["@graph"]) walk(v["@graph"]); } }; walk(json); } catch { /* not JSON */ }
  }
  const out: Booking[] = [];
  for (const r of items) {
    const kind = MARKUP_KINDS[typeName(r["@type"])];
    const f = r.reservationFor || {};
    const status = /Cancel/i.test(String(r.reservationStatus || "")) ? "cancelled" : "confirmed";
    const base = { kind, status: status as Booking["status"], confirmation: str(r.reservationNumber), mid, mids: [mid] };
    let b: Omit<Booking, "key"> | null = null;
    if (kind === "flight" || kind === "train") {
      const start = clockOf(f.departureTime), end = clockOf(f.arrivalTime);
      const carrier = str(f.airline?.iataCode) || str(f.provider?.iataCode);
      const number = kind === "flight" ? [carrier, str(f.flightNumber)].filter(Boolean).join(" ") : str(f.trainNumber);
      if (start) b = { ...base, provider: str(f.airline?.name) || str(f.provider?.name) || str(f.trainCompany?.name), number, from: placeOf(f.departureAirport || f.departureStation || f.departureBusStop), to: placeOf(f.arrivalAirport || f.arrivalStation || f.arrivalBusStop), gate: str(f.departureGate), terminal: str(f.departureTerminal), seat: str(r.airplaneSeat) || str(r.reservedTicket?.ticketedSeat?.seatNumber), start, ...(end ? { end } : {}) };
    } else if (kind === "hotel") {
      const start = clockOf(r.checkinTime || r.checkinDate), end = clockOf(r.checkoutTime || r.checkoutDate);
      if (start) b = { ...base, name: str(f.name), provider: str(f.name), address: addressOf(f), city: str(f.address?.addressLocality), start, ...(end ? { end } : {}) };
    } else if (kind === "car") {
      const start = clockOf(r.pickupTime), end = clockOf(r.dropoffTime);
      if (start) b = { ...base, provider: str(r.provider?.name) || str(f.rentalCompany?.name) || str(f.brand?.name), name: str(r.pickupLocation?.name), address: addressOf(r.pickupLocation), city: str(r.pickupLocation?.address?.addressLocality), start, ...(end ? { end } : {}) };
    } else {
      const start = clockOf(f.startDate || r.startTime), end = clockOf(f.endDate);
      if (start) b = { ...base, name: str(f.name) || str(f.location?.name), provider: str(f.name), address: addressOf(f.location || f), city: str((f.location || f).address?.addressLocality), start, ...(end ? { end } : {}) };
    }
    if (b) { const clean = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as Omit<Booking, "key">; out.push({ ...clean, key: bookingKey(clean) }); }
  }
  return out;
}

// ---------------------------------------------------------------- Workers AI

export const TRAVEL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const TRAVEL_TEXT_CHARS = 6000;
const KINDS: BookingKind[] = ["flight", "hotel", "car", "train", "event", "restaurant"];
const BOOKING_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: KINDS },
    status: { type: "string", enum: ["confirmed", "changed", "cancelled"] },
    provider: { type: "string" }, number: { type: "string" }, name: { type: "string" },
    from_code: { type: "string" }, from_city: { type: "string" }, to_code: { type: "string" }, to_city: { type: "string" },
    address: { type: "string" }, city: { type: "string" }, confirmation: { type: "string" },
    start_local: { type: "string" }, start_timezone: { type: "string" }, end_local: { type: "string" }, end_timezone: { type: "string" },
    seat: { type: "string" }, gate: { type: "string" }, terminal: { type: "string" },
  },
  required: ["kind", "status", "start_local", "start_timezone"],
};

/** The Workers AI request that reads an email's bookings. */
export function travelRequest(email: { from: string; subject: string; date: Date | string; text: string }) {
  return {
    messages: [
      { role: "system", content: [
        "You read one email and list the travel bookings the recipient has made, for a travel planner.",
        "Only real bookings, itineraries, changes or cancellations for the recipient (flights, hotels and other stays, rental cars, trains, buses, booked events, restaurant reservations). Not ads, deals, price alerts, loyalty statements, surveys or receipts for rides already taken. None: an empty list.",
        "One entry per flight leg, stay, car, train or event. A round trip is two flights.",
        "start_local and end_local: the local time where it happens, as YYYY-MM-DDTHH:MM (a date alone: YYYY-MM-DD). Flights: start = departure, end = arrival. Stays: start = check-in, end = check-out. Cars: pick-up and drop-off.",
        "start_timezone and end_timezone: the IANA time zone of that place (America/New_York for JFK, Europe/Lisbon for LIS).",
        "number: the flight or train number with the airline code (TP 1351). from_code/to_code: airport IATA codes. status: changed when this email changes an earlier booking (new time, gate, seat), cancelled when it cancels one.",
        "Copy names, addresses and confirmation codes exactly. Leave out what the email doesn't say; never guess a gate or seat.",
      ].join(" ") },
      { role: "user", content: `From: ${email.from}\nSubject: ${email.subject}\nDate: ${new Date(email.date).toUTCString()}\n\n${email.text.slice(0, TRAVEL_TEXT_CHARS)}` },
    ],
    response_format: { type: "json_schema", json_schema: { type: "object", properties: { bookings: { type: "array", items: BOOKING_SCHEMA } }, required: ["bookings"] } },
    max_tokens: 1500,
    temperature: 0,
  };
}

/** The bookings in Workers AI's answer (anything unreadable or without a time is left out), or null when the answer isn't readable at all. */
export function travelAnswer(body: any, mid: string): Booking[] | null {
  let answer = (body?.result ?? body)?.response;
  if (typeof answer === "string") { try { answer = JSON.parse(answer.replace(/^```(?:json)?|```$/g, "").trim()); } catch { return null; } }
  if (!answer || !Array.isArray(answer.bookings)) return null;
  const out: Booking[] = [];
  for (const a of answer.bookings) {
    if (!a || !KINDS.includes(a.kind)) continue;
    const start = localInstant(a.start_local, a.start_timezone);
    if (!start) continue;
    const end = a.end_local ? localInstant(a.end_local, a.end_timezone || a.start_timezone) : null;
    const place = (code?: string, city?: string): Place | undefined => (str(code) || str(city) ? { ...(str(code) ? { code: str(code)!.toUpperCase() } : {}), ...(str(city) ? { city: str(city) } : {}) } : undefined);
    const b: Omit<Booking, "key"> = {
      kind: a.kind, status: a.status === "cancelled" ? "cancelled" : "confirmed", mid, mids: [mid], start,
      ...(end && end.at >= start.at ? { end } : {}),
      ...Object.fromEntries((["provider", "number", "name", "address", "city", "confirmation", "seat", "gate", "terminal"] as const).map((k) => [k, str(a[k])]).filter(([, v]) => v)),
      ...(place(a.from_code, a.from_city) ? { from: place(a.from_code, a.from_city) } : {}),
      ...(place(a.to_code, a.to_city) ? { to: place(a.to_code, a.to_city) } : {}),
    };
    if (b.number) b.number = b.number.replace(/^([A-Z0-9]{2})\s*(\d+)$/i, (_, c, n) => `${c.toUpperCase()} ${n}`);
    out.push({ ...b, key: bookingKey(b) });
  }
  return out;
}

// ---------------------------------------------------------------- merging and trips

const norm = (s?: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
/** The same booking across emails (a confirmation, then its change): flight/train by number and date; stays by
 *  confirmation or name; cars by confirmation or company and date. */
export function bookingKey(b: Pick<Booking, "kind" | "number" | "confirmation" | "name" | "provider" | "start">): string {
  const day = dayKey(b.start);
  if ((b.kind === "flight" || b.kind === "train") && b.number) return `${b.kind}|${norm(b.number)}|${day}`;
  if (b.kind === "hotel") return `hotel|${norm(b.confirmation) || norm(b.name || b.provider)}`;
  if (b.kind === "car") return `car|${norm(b.confirmation) || norm(b.provider)}|${day}`;
  return `${b.kind}|${norm(b.name || b.provider)}|${day}`;
}

/** Each booking once, from every email about it, oldest first: later emails win, and what they changed
 *  (gate, time, cancelled) is kept as `was`. */
export function mergeBookings(records: { mid: string; date: number; bookings: Booking[] }[]): Booking[] {
  const out = new Map<string, Booking>();
  for (const record of [...records].sort((a, b) => a.date - b.date)) {
    for (const b of record.bookings) {
      const old = out.get(b.key);
      if (!old) { out.set(b.key, { ...b, mids: [record.mid] }); continue; }
      const was: Booking["was"] = { ...old.was };
      let changed = false;
      if (b.gate && old.gate && b.gate !== old.gate) { was.gate = old.gate; changed = true; }
      if (Math.abs(b.start.at - old.start.at) >= 60000) { was.start = old.start; changed = true; }
      if (b.status !== old.status) { was.status = old.status; changed = true; }
      const merged: Booking = { ...old, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined && v !== "")), mids: [...old.mids, record.mid], mid: record.mid } as Booking;
      if (Object.keys(was).length) merged.was = was;
      if (changed) merged.changedAt = record.date;
      out.set(b.key, merged);
    }
  }
  return [...out.values()].sort((a, b) => a.start.at - b.start.at);
}

export interface Trip {
  id: string;
  city: string;
  /** Where it is, for local times ("Europe/Lisbon"); undefined when the bookings don't say. */
  tz?: string;
  start: Clock;
  end: Clock;
  bookings: Booking[];
  /** Every email about the trip (Message-IDs). */
  mids: string[];
  phase: "upcoming" | "now" | "past";
}

const GAP = 36 * 3600000;
/** A trip is under way from this long before its first departure (travel day: the airport card shows). */
const TRAVEL_DAY = 12 * 3600000;
const endOf = (b: Booking) => (b.end ?? b.start).at;
const cityOf = (p?: Place) => p?.city || p?.name?.replace(/\s+(?:International\s+)?Airport$/i, "") || p?.code || "";

/** Bookings close together (≤ 36 h apart) are one trip when there's a flight, train or stay among them. */
export function buildTrips(bookings: Booking[], now: number, homeTz?: string): Trip[] {
  const live = [...bookings].sort((a, b) => a.start.at - b.start.at);
  const groups: Booking[][] = [];
  for (const b of live) {
    const last = groups.at(-1);
    if (last && b.start.at <= Math.max(...last.map(endOf)) + GAP) last.push(b); else groups.push([b]);
  }
  const trips: Trip[] = [];
  for (const group of groups) {
    const active = group.filter((b) => b.status !== "cancelled");
    const core = active.filter((b) => b.kind === "flight" || b.kind === "train" || b.kind === "hotel");
    if (!core.length) continue;
    const hotel = core.find((b) => b.kind === "hotel");
    const outbound = core.find((b) => b.kind !== "hotel");
    const away = (b?: Booking) => !!b && (!homeTz || !b.end?.tz || b.end.tz !== homeTz);
    const city = hotel?.city || (away(outbound) ? cityOf(outbound?.to) : "") || zoneCity(hotel?.start.tz) || cityOf(outbound?.to) || hotel?.name || "Trip";
    const tz = hotel?.start.tz || (outbound?.end?.tz ?? outbound?.start.tz);
    const start = active.reduce((a, b) => (b.start.at < a.start.at ? b : a)).start;
    const last = active.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
    const end = last.end ?? last.start;
    trips.push({ id: `${norm(city)}-${dayKey(start)}`, city, tz, start, end, bookings: group, mids: [...new Set(group.flatMap((b) => b.mids))], phase: now < start.at - TRAVEL_DAY ? "upcoming" : now <= end.at ? "now" : "past" });
  }
  return trips;
}

/** Trips worth showing: from 60 days ahead to a week after. */
export function currentTrips(trips: Trip[], now: number): Trip[] {
  return trips.filter((t) => t.start.at - now <= 60 * 86400000 && now - t.end.at <= 7 * 86400000);
}

/** "in 5 days", "tomorrow", "today". */
export function untilText(at: number, now: number, tz?: string): string {
  const days = Math.round((Date.parse(dayKey({ at, tz })) - Date.parse(dayKey({ at: now, tz }))) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}
/** When you're there: the first landing or check-in (the trip's start when neither is known). */
export function arrivedAt(trip: Trip): number {
  const times = trip.bookings.filter((b) => b.status !== "cancelled").flatMap((b) => (b.kind === "flight" || b.kind === "train") && b.end ? [b.end.at] : b.kind === "hotel" ? [b.start.at] : []);
  return times.length ? Math.min(...times) : trip.start.at;
}
/** "Day 2" of the trip (local dates; day 1 is the day you arrive, 0 or less before that). */
export function tripDay(trip: Trip, now: number): number {
  const there = arrivedAt(trip);
  if (now < there) return 0; // still getting there (travel day)
  const day = (at: number) => Date.parse(dayKey({ at, tz: trip.tz }));
  return Math.round((day(now) - day(there)) / 86400000) + 1;
}

export function bookingTitle(b: Booking): string {
  if (b.kind === "flight" || b.kind === "train") {
    const route = b.from?.code || b.to?.code ? `${b.from?.code || cityOf(b.from)} → ${b.to?.code || cityOf(b.to)}` : [cityOf(b.from), cityOf(b.to)].filter(Boolean).join(" → ");
    return [b.number || b.provider, route].filter(Boolean).join(" · ") || (b.kind === "flight" ? "Flight" : "Train");
  }
  if (b.kind === "car") return b.provider || b.name || "Rental car";
  return b.name || b.provider || ({ hotel: "Stay", car: "Rental car", event: "Event", restaurant: "Restaurant" } as Record<string, string>)[b.kind] || "Booking";
}

export interface NowCard { booking: Booking; moment: "flight" | "arrival" | "stay" | "car" | "event" | "checkout"; until: number }
/** What matters now on a trip: the next flight (from a day before), the hotel on arrival, a car or event within a
 *  few hours, the check-out morning. Changed bookings first. */
export function rightNow(trip: Trip, now: number): NowCard[] {
  const cards: NowCard[] = [];
  const H = 3600000;
  const active = trip.bookings.filter((b) => b.status !== "cancelled");
  for (const b of active) {
    if (b.kind === "flight" || b.kind === "train") {
      if (now >= b.start.at - 24 * H && now < b.start.at) cards.push({ booking: b, moment: "flight", until: b.start.at });
    } else if (b.kind === "hotel") {
      // Not while the flight there is still ahead (you aren't there yet).
      if (active.some((f) => (f.kind === "flight" || f.kind === "train") && f.start.at > now && f.start.at < b.start.at)) continue;
      const landed = active.find((f) => (f.kind === "flight" || f.kind === "train") && f.end && f.end.at <= now && now - f.end.at < 8 * H);
      const checkinDay = dayKey(b.start) === dayKey({ ...b.start, at: now });
      if ((landed && b.start.at - now < 24 * H && now < b.start.at + 6 * H) || (checkinDay && now < b.start.at + 6 * H)) cards.push({ booking: b, moment: landed ? "arrival" : "stay", until: b.start.at + 6 * H });
      else if (b.end && now >= b.end.at - 5 * H && now < b.end.at) cards.push({ booking: b, moment: "checkout", until: b.end.at });
    } else if (b.kind === "car") {
      if (now >= b.start.at - 12 * H && now < b.start.at + H) cards.push({ booking: b, moment: "car", until: b.start.at + H });
    } else if (now >= b.start.at - 3 * H && now < b.start.at + 30 * 60000) cards.push({ booking: b, moment: "event", until: b.start.at + 30 * 60000 });
  }
  return cards.sort((a, b) => Number(!!b.booking.was) - Number(!!a.booking.was) || a.booking.start.at - b.booking.start.at);
}

/** A change worth pinning: recent (two days) and the booking still ahead or under way. */
export function pinnedChanges(trip: Trip, now: number): Booking[] {
  return trip.bookings.filter((b) => b.was && b.changedAt && now - b.changedAt < 2 * 86400000 && endOf(b) > now);
}

/** "Gate changed: TP 1351 now leaves from B27", "TP 1351 now leaves at 9:10 PM", "TP 1351 was cancelled". */
export function changeText(b: Booking): string {
  const what = b.number || bookingTitle(b);
  if (b.status === "cancelled" && b.was?.status) return `${what} was cancelled`;
  if (b.was?.gate && b.gate) return `Gate changed: ${what} now leaves from ${b.gate}`;
  if (b.was?.start) return `${what} now ${b.kind === "hotel" ? "starts" : "leaves"} ${dayKey(b.was.start) === dayKey(b.start) ? "at" : "on"} ${dayKey(b.was.start) === dayKey(b.start) ? timeText(b.start) : `${dayText(b.start)}, ${timeText(b.start)}`}`;
  return `${what} changed`;
}

export interface TimelineItem { at: Clock; booking: Booking; label: string; detail: string; arrival?: boolean }
/** The trip day by day (local dates), each booking at its start (and flights again at arrival, stays at check-out). */
export function timeline(trip: Trip): { day: string; key: string; items: TimelineItem[] }[] {
  const items: TimelineItem[] = [];
  for (const b of trip.bookings) {
    const title = bookingTitle(b);
    if (b.kind === "flight" || b.kind === "train") {
      items.push({ at: b.start, booking: b, label: `${b.kind === "flight" ? "Flight" : "Train"} ${title}`, detail: [b.terminal && `Terminal ${b.terminal}`, b.gate && `Gate ${b.gate}`, b.seat && `Seat ${b.seat}`, b.confirmation && `#${b.confirmation}`].filter(Boolean).join(" · ") });
      if (b.end) items.push({ at: b.end, booking: b, label: `Land in ${cityOf(b.to) || "destination"}`, detail: b.number || "", arrival: true });
    } else if (b.kind === "hotel") {
      items.push({ at: b.start, booking: b, label: `Check in, ${title}`, detail: [b.address, b.confirmation && `#${b.confirmation}`].filter(Boolean).join(" · ") });
      if (b.end) items.push({ at: b.end, booking: b, label: `Check out, ${title}`, detail: "", arrival: true });
    } else if (b.kind === "car") {
      items.push({ at: b.start, booking: b, label: `Car pick-up, ${title}`, detail: [b.name, b.address, b.confirmation && `#${b.confirmation}`].filter(Boolean).join(" · ") });
      if (b.end) items.push({ at: b.end, booking: b, label: `Car drop-off, ${title}`, detail: "", arrival: true });
    } else items.push({ at: b.start, booking: b, label: title, detail: [b.address, b.confirmation && `#${b.confirmation}`].filter(Boolean).join(" · ") });
  }
  items.sort((a, b) => a.at.at - b.at.at);
  const days: { day: string; key: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    // Each on its own local date (a departure on New York's evening, its landing on Lisbon's morning).
    const clock = item.at.tz || item.at.offset !== undefined ? item.at : trip.tz ? { at: item.at.at, tz: trip.tz } : item.at;
    const key = dayKey(clock);
    let day = days.at(-1);
    if (!day || day.key !== key) { day = { key, day: dayText(clock), items: [] }; days.push(day); }
    day.items.push(item);
  }
  return days;
}

/** Flights whose online check-in opens (24 h before) in the future: when. */
export function checkInTimes(bookings: Booking[], now: number): { booking: Booking; at: number }[] {
  return bookings.filter((b) => b.kind === "flight" && b.status !== "cancelled" && b.start.at - 24 * 3600000 > now).map((b) => ({ booking: b, at: b.start.at - 24 * 3600000 }));
}

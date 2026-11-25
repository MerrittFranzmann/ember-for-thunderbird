// How the Ember window shows a trip (TripStrip, Trip): the words for a booking right now, the trip's dates,
// both clocks, map links, and opening a booking's email. Pure apart from openBookingEmail.
import { bookingTitle, dayText, otherZone, timeText, zoneCity, type Booking, type Clock, type NowCard, type Trip } from "./trips";

const cityOf = (b: Booking) => b.to?.city || b.to?.code || "";
/** "Nov 3–7", "Oct 30–Nov 2". */
export function tripDates(trip: Trip): string {
  // Each end on its own local date (leaving New York on the 29th, home on the 3rd).
  const clock = (c: Clock) => (c.tz || c.offset !== undefined || !trip.tz ? c : { at: c.at, tz: trip.tz });
  const a = dayText(clock(trip.start)).split(", ").pop()!, b = dayText(clock(trip.end)).split(", ").pop()!;
  if (a === b) return a;
  const [am, ad] = a.split(" "), [bm, bd] = b.split(" ");
  return am === bm ? `${am} ${ad}–${bd}` : `${a}–${b}`;
}
/** "7:50 AM" at the place, and home's time when it differs ("2:50 AM home"). */
export function bothClocks(clock: Clock, homeTz: string): { local: string; home: string } {
  return { local: timeText(clock), home: otherZone(clock, homeTz) ? `${timeText({ at: clock.at, tz: homeTz })} home` : "" };
}
/** "Lisbon 8:20 AM · home 3:20 AM" while the trip's place keeps another time. */
export function clockLine(trip: Trip, now: number, homeTz: string): string {
  if (!trip.tz || !otherZone({ at: now, tz: trip.tz }, homeTz)) return "";
  return `${trip.city || zoneCity(trip.tz)} ${timeText({ at: now, tz: trip.tz })} · home ${timeText({ at: now, tz: homeTz })}`;
}
export const mapLink = (place: string) => `https://maps.apple.com/?q=${encodeURIComponent(place)}`;
/** Minutes or hours until, "in 40 min", "in 3 h", "now". */
export function soon(at: number, now: number): string {
  const min = Math.round((at - now) / 60000);
  if (min <= 0) return "now";
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
}
/** A "right now" card's title and lines. */
export function cardText(card: NowCard, now: number): { title: string; lines: string[]; place?: string } {
  const b = card.booking;
  const at = `${timeText(b.start)}${b.start.at > now ? `, ${soon(b.start.at, now)}` : ""}`;
  if (card.moment === "flight") return {
    title: `${b.number || bookingTitle(b)}${cityOf(b) ? ` to ${cityOf(b)}` : ""} · leaves ${at}`,
    lines: [[b.terminal && `Terminal ${b.terminal}`, b.gate && `Gate ${b.gate}${b.was?.gate ? ` (was ${b.was.gate})` : ""}`, b.seat && `Seat ${b.seat}`, b.end && `lands ${timeText(b.end)}${b.end.tz && b.end.tz !== b.start.tz ? ` ${zoneCity(b.end.tz)} time` : ""}`].filter(Boolean).join(" · "), b.confirmation ? `Confirmation ${b.confirmation}` : ""].filter(Boolean),
  };
  if (card.moment === "arrival" || card.moment === "stay") return {
    title: `${bookingTitle(b)} · check-in from ${timeText(b.start)}`,
    lines: [b.address || "", [b.confirmation && `Confirmation ${b.confirmation}`, b.end && `until ${dayText(b.end)}`].filter(Boolean).join(" · ")].filter(Boolean),
    place: b.address || [b.name, b.city].filter(Boolean).join(", "),
  };
  if (card.moment === "checkout") return { title: `Check out of ${bookingTitle(b)} by ${timeText(b.end!)}`, lines: [b.confirmation ? `Confirmation ${b.confirmation}` : ""].filter(Boolean) };
  if (card.moment === "car") return {
    title: `Car pick-up, ${bookingTitle(b)} · ${at}`,
    lines: [[b.name, b.address].filter(Boolean).join(", "), b.confirmation ? `Confirmation ${b.confirmation}` : ""].filter(Boolean),
    place: b.address || b.name,
  };
  return { title: `${bookingTitle(b)} · ${at}`, lines: [b.address || "", b.confirmation ? `Confirmation ${b.confirmation}` : ""].filter(Boolean), place: b.address || b.name };
}
/** Who the trip's bookings are with, for its row ("TAP · Casa do Rio · Atlântico"). */
export function providers(trip: Trip): string {
  return [...new Set(trip.bookings.filter((b) => b.status !== "cancelled").map((b) => b.kind === "flight" || b.kind === "train" ? (b.provider || b.number?.split(" ")[0] || "") : bookingTitle(b)).filter(Boolean))].join(" · ");
}
export const bookingIcon = (b: Booking) => ({ flight: "plane", train: "plane", hotel: "bed", car: "car", event: "calendar", restaurant: "calendar" })[b.kind];

const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const RIDES_AND_TRAVEL = /\b(?:uber|lyft|bolt|free ?now|cabify|grab|didi|taxi|cab|parking|toll|airbnb|booking\.com|expedia|hotels?|airlines?|airways|rail|train|amtrak|hertz|avis|sixt|enterprise)\b/;
/** A receipt that belongs to the trip: a ride or travel company, one of the trip's own bookings, or naming its city. */
export function tripReceipt(m: { author: string; subject: string }, trip: Trip): boolean {
  const text = plain(`${m.author} ${m.subject}`);
  if (RIDES_AND_TRAVEL.test(text) || (trip.city && text.includes(plain(trip.city)))) return true;
  return trip.bookings.some((b) => [b.provider, b.name].some((n) => n && n.length > 3 && text.includes(plain(n).split(/\s+/)[0])));
}

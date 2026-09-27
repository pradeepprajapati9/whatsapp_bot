/**
 * slots.ts — deciding whether the clinic can actually take this patient.
 *
 * HOW INDIAN CLINICS REALLY WORK, AND WHY THAT DECIDES THE DESIGN
 *
 * Western booking software assumes exact slots: 4:00, 4:15, 4:30, one patient
 * each. Almost no small Indian clinic works that way. They work on tokens and
 * loose bands — "shaam 5 ke baad aa jaiye" — and a doctor may see three people
 * in the time a Western system allots to one.
 *
 * Build rigid slots and the clinic will not use the software. They will keep
 * the register, and the bot becomes a toy.
 *
 * So this is CAPACITY PER BAND, not exact slots:
 *
 *     the day is cut into bands (default 30 min)
 *     each band holds N patients (the clinic sets N, often 2-4)
 *     a band is full when N are booked
 *
 * That matches the token reality, and still gives the one thing the register
 * cannot: a machine-readable answer to "is 5 PM tomorrow full?".
 *
 * WHY A CANCELLATION IS THE POINT
 *
 * Cancelling frees a place in the band immediately, and that freed place can be
 * offered to someone else. A no-show frees nothing, because nobody knew. The
 * whole product is the difference between those two, so cancelling is made
 * easy on purpose — see reminders.ts.
 */

import { formatIST, isOpen, type ParsedTime } from "./timeparse.ts";

export interface ClinicHours {
  /** 24-hour clock, e.g. 10 and 19 for a 10 AM - 7 PM OPD. */
  openHour: number;
  closeHour: number;
  /** Days the clinic is shut. 0 = Sunday, which is the usual one. */
  closedDays: number[];
  /** Minutes per band. 30 suits a token system; 15 suits a stricter practice. */
  bandMinutes: number;
  /** How many patients the doctor will see in one band. */
  perBand: number;
  /** A lunch or surgery break, as [startHour, endHour]. */
  breakHours?: [number, number];
}

export const DEFAULT_HOURS: ClinicHours = {
  openHour: 10,
  closeHour: 19,
  closedDays: [0],
  bandMinutes: 30,
  perBand: 3,
  breakHours: [14, 15],
};

export type Verdict =
  | { ok: true; at: Date; label: string }
  | { ok: false; reason: ClosedReason; at: Date | null; alternatives: Date[] };

export type ClosedReason =
  | "in_the_past"
  | "clinic_closed_that_day"
  | "outside_hours"
  | "on_break"
  | "band_full"
  | "too_far_ahead";

/** The start of the band a given moment falls into. */
export function bandStart(at: Date, hours: ClinicHours): Date {
  const d = new Date(at);
  const mins = d.getHours() * 60 + d.getMinutes();
  const snapped = Math.floor(mins / hours.bandMinutes) * hours.bandMinutes;
  d.setHours(Math.floor(snapped / 60), snapped % 60, 0, 0);
  return d;
}

/** Every band the clinic runs on a given day. */
export function bandsOn(day: Date, hours: ClinicHours): Date[] {
  const out: Date[] = [];
  if (hours.closedDays.includes(day.getDay())) return out;
  const d = new Date(day);
  d.setHours(hours.openHour, 0, 0, 0);
  const end = new Date(day);
  end.setHours(hours.closeHour, 0, 0, 0);
  while (d < end) {
    const h = d.getHours() + d.getMinutes() / 60;
    const onBreak = hours.breakHours && h >= hours.breakHours[0] && h < hours.breakHours[1];
    if (!onBreak) out.push(new Date(d));
    d.setMinutes(d.getMinutes() + hours.bandMinutes);
  }
  return out;
}

/**
 * Can this time be booked?
 *
 * `taken` maps a band's ISO start time to how many patients are already in it.
 * It is passed in rather than fetched here so this stays pure and testable —
 * the database lives in store.ts.
 */
export function check(
  at: Date,
  hours: ClinicHours,
  taken: Record<string, number>,
  now: Date = new Date(),
  horizonDays = 60,
): Verdict {
  const band = bandStart(at, hours);

  if (at.getTime() < now.getTime()) {
    return { ok: false, reason: "in_the_past", at, alternatives: suggest(now, hours, taken, now) };
  }
  if ((at.getTime() - now.getTime()) / 86400000 > horizonDays) {
    return { ok: false, reason: "too_far_ahead", at, alternatives: [] };
  }
  if (hours.closedDays.includes(at.getDay())) {
    return { ok: false, reason: "clinic_closed_that_day", at,
             alternatives: suggest(at, hours, taken, now) };
  }
  const h = at.getHours() + at.getMinutes() / 60;
  if (hours.breakHours && h >= hours.breakHours[0] && h < hours.breakHours[1]) {
    return { ok: false, reason: "on_break", at, alternatives: suggest(at, hours, taken, now) };
  }
  if (!isOpen(at, hours.openHour, hours.closeHour, hours.closedDays)) {
    return { ok: false, reason: "outside_hours", at, alternatives: suggest(at, hours, taken, now) };
  }
  if ((taken[band.toISOString()] ?? 0) >= hours.perBand) {
    return { ok: false, reason: "band_full", at, alternatives: suggest(at, hours, taken, now) };
  }
  return { ok: true, at: band, label: formatIST(band) };
}

/**
 * The nearest times that ARE free.
 *
 * Never reply with a bare "not available" — a patient who is told no and given
 * nothing simply leaves. Offering three specific alternatives is the difference
 * between a lost booking and a moved one.
 */
export function suggest(
  near: Date,
  hours: ClinicHours,
  taken: Record<string, number>,
  now: Date = new Date(),
  count = 3,
  searchDays = 7,
): Date[] {
  const out: Date[] = [];
  const day = new Date(near);
  day.setHours(0, 0, 0, 0);

  for (let i = 0; i < searchDays && out.length < count; i++) {
    const bands = bandsOn(day, hours);
    // Closest to what they asked for first — someone who wanted evening wants
    // evening, not the first free slot at 10 AM.
    const sorted = bands
      .filter((b) => b.getTime() > now.getTime())
      .sort((a, b) => Math.abs(a.getTime() - near.getTime()) - Math.abs(b.getTime() - near.getTime()));
    for (const b of sorted) {
      if ((taken[b.toISOString()] ?? 0) < hours.perBand) {
        out.push(b);
        if (out.length >= count) break;
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** How full the day is — what a receptionist actually wants to see. */
export function dayLoad(day: Date, hours: ClinicHours, taken: Record<string, number>) {
  const bands = bandsOn(day, hours);
  const capacity = bands.length * hours.perBand;
  let booked = 0;
  for (const b of bands) booked += taken[b.toISOString()] ?? 0;
  return {
    bands: bands.length,
    capacity,
    booked,
    free: capacity - booked,
    percent: capacity ? Math.round((booked / capacity) * 100) : 0,
  };
}

export const REASON_TEXT: Record<ClosedReason, Record<string, string>> = {
  in_the_past: {
    hinglish: "Wo time to nikal chuka hai 🙂",
    hindi: "वह समय निकल चुका है 🙂",
    english: "That time has already passed 🙂",
  },
  clinic_closed_that_day: {
    hinglish: "Us din clinic band rehti hai.",
    hindi: "उस दिन क्लिनिक बंद रहती है।",
    english: "The clinic is closed that day.",
  },
  outside_hours: {
    hinglish: "Us waqt clinic khuli nahi hoti.",
    hindi: "उस समय क्लिनिक खुली नहीं होती।",
    english: "The clinic is not open at that time.",
  },
  on_break: {
    hinglish: "Us waqt lunch break hota hai.",
    hindi: "उस समय लंच ब्रेक होता है।",
    english: "That is during the lunch break.",
  },
  band_full: {
    hinglish: "Us time ki booking full ho chuki hai.",
    hindi: "उस समय की बुकिंग फुल हो चुकी है।",
    english: "That time is already fully booked.",
  },
  too_far_ahead: {
    hinglish: "Itni aage ki booking abhi nahi hoti.",
    hindi: "इतनी आगे की बुकिंग अभी नहीं होती।",
    english: "Bookings do not open that far ahead yet.",
  },
};

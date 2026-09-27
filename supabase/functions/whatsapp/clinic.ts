/**
 * clinic.ts — the doctor's and receptionist's side.
 *
 * THE ONE DESIGN DECISION THAT MATTERS HERE
 *
 * A receptionist will not open a dashboard. She is on the phone, there is a
 * queue at the desk, and the computer — if there is one — is running the old
 * billing software. Any product that needs her to log in somewhere has already
 * lost, no matter how good the screen is.
 *
 * So the clinic gets everything on WhatsApp too, on the same number they
 * already watch all day:
 *
 *     morning     one message: who is coming, who confirmed, who cancelled
 *     live        one line whenever someone books or cancels
 *     on demand   they type "aaj" or "kal" and get the list back
 *
 * A web page exists for whoever wants one, but nothing depends on it. If the
 * clinic never opens a browser, the product still works completely.
 *
 * WHY THE MORNING MESSAGE LEADS WITH CANCELLATIONS
 *
 * The number the clinic is paying for is the one that lets them refill an hour.
 * A confirmed patient needs no action. A cancellation is an empty chair that
 * somebody could still be sitting in — so it goes first, with the freed time
 * spelled out, because that is the line that earns the subscription.
 */

import { formatIST } from "./timeparse.ts";
import { type ClinicHours, bandsOn, dayLoad } from "./slots.ts";

export interface Appt {
  id: number;
  name: string;
  phone: string;
  service: string;
  scheduled_at: string;
  status: string;
  raw_time?: string;
}

const STATUS_ICON: Record<string, string> = {
  confirmed: "✅",
  booked: "🕐",
  cancelled: "❌",
  no_show: "⚠️",
  done: "☑️",
};

function timeOnly(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

/**
 * The message the clinic gets each morning.
 *
 * Written to be read on a phone in five seconds, standing up, between patients.
 * No tables, no scrolling, no jargon.
 */
export function morningDigest(
  appts: Appt[],
  day: Date,
  hours: ClinicHours,
  clinicName = "",
): string {
  const live = appts.filter((a) => a.status === "booked" || a.status === "confirmed");
  const cancelled = appts.filter((a) => a.status === "cancelled");
  const confirmed = live.filter((a) => a.status === "confirmed");
  const silent = live.filter((a) => a.status === "booked");

  const dateLabel = formatIST(day).split(",")[0];
  const lines: string[] = [];
  lines.push(`☀️ *Aaj — ${dateLabel}*`);
  if (clinicName) lines.push(clinicName);
  lines.push("");
  lines.push(`👥 *${live.length}* patients aa rahe hain`);
  lines.push(`   ✅ ${confirmed.length} ne confirm kiya`);
  if (silent.length) lines.push(`   🕐 ${silent.length} ne abhi jawab nahi diya`);

  // The money line. A cancellation that nobody notices is the same as a
  // no-show, so it is put where it cannot be missed.
  if (cancelled.length) {
    lines.push("");
    lines.push(`❌ *${cancelled.length} ne cancel kiya — ye time ab KHALI hai:*`);
    for (const a of cancelled) {
      lines.push(`   • ${timeOnly(a.scheduled_at)} — ${a.name}`);
    }
    lines.push("   _Waiting list se kisi ko bula sakte hain._");
  }

  if (live.length) {
    lines.push("");
    lines.push("*Aaj ki list:*");
    for (const a of live.sort((x, y) => x.scheduled_at.localeCompare(y.scheduled_at))) {
      lines.push(
        `${STATUS_ICON[a.status] ?? "•"} ${timeOnly(a.scheduled_at)}  ${a.name}` +
        (a.service ? ` — ${a.service}` : ""),
      );
    }
  } else {
    lines.push("");
    lines.push("Aaj koi appointment nahi hai.");
  }

  const load = dayLoad(day, hours, countByBand(live, hours));
  lines.push("");
  lines.push(`📊 Din ${load.percent}% bhara — ${load.free} jagah abhi khali hai`);
  return lines.join("\n");
}

/** How many patients sit in each band — what slots.ts needs to judge capacity. */
export function countByBand(appts: Appt[], hours: ClinicHours): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of appts) {
    if (a.status === "cancelled" || a.status === "no_show") continue;
    const d = new Date(a.scheduled_at);
    const mins = d.getHours() * 60 + d.getMinutes();
    const snapped = Math.floor(mins / hours.bandMinutes) * hours.bandMinutes;
    const band = new Date(d);
    band.setHours(Math.floor(snapped / 60), snapped % 60, 0, 0);
    const key = band.toISOString();
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** The one-liner sent the moment a patient books. */
export function bookedAlert(a: Appt): string {
  return (
    "🆕 *Nayi booking*\n" +
    `${a.name}  ·  ${a.phone}\n` +
    `${formatIST(new Date(a.scheduled_at))}\n` +
    (a.service ? a.service : "")
  );
}

/** And the moment they cancel. Phrased as an opportunity, not a loss, because
 *  that is what it is if anyone acts on it in time. */
export function cancelledAlert(a: Appt): string {
  return (
    "❌ *Cancel hua*\n" +
    `${a.name}  ·  ${a.phone}\n` +
    `${formatIST(new Date(a.scheduled_at))}\n\n` +
    "_Ye slot ab khali hai — kisi aur ko de sakte hain._"
  );
}

/**
 * What the clinic sees when it types a word into its own WhatsApp.
 *
 * Deliberately tiny: three commands, all in words a receptionist already uses.
 * Anything a person has to look up in a manual will not be used.
 */
export const STAFF_COMMANDS: Record<string, string[]> = {
  today: ["aaj", "today", "आज", "list"],
  tomorrow: ["kal", "tomorrow", "कल"],
  free: ["khali", "free", "खाली", "slot"],
};

export function readStaffCommand(text: string): "today" | "tomorrow" | "free" | null {
  const t = (text || "").toLowerCase().trim();
  for (const [cmd, words] of Object.entries(STAFF_COMMANDS)) {
    if (words.some((w) => t === w || t.startsWith(w + " "))) {
      return cmd as "today" | "tomorrow" | "free";
    }
  }
  return null;
}

/** A compact list for an on-demand "aaj" / "kal". */
export function dayList(appts: Appt[], day: Date, label: string): string {
  const live = appts
    .filter((a) => a.status === "booked" || a.status === "confirmed")
    .sort((x, y) => x.scheduled_at.localeCompare(y.scheduled_at));
  if (!live.length) return `${label}: koi appointment nahi hai.`;
  const lines = [`*${label} — ${live.length} patients*`, ""];
  for (const a of live) {
    lines.push(
      `${STATUS_ICON[a.status] ?? "•"} ${timeOnly(a.scheduled_at)}  ${a.name}  ` +
      `· ${a.phone}` + (a.service ? `\n     ${a.service}` : ""),
    );
  }
  return lines.join("\n");
}

/** Which bands still have room — for "khali". */
export function freeList(appts: Appt[], day: Date, hours: ClinicHours): string {
  const taken = countByBand(appts, hours);
  const bands = bandsOn(day, hours);
  const free = bands.filter((b) => (taken[b.toISOString()] ?? 0) < hours.perBand);
  if (!free.length) return "Aaj koi slot khali nahi hai.";
  const lines = [`*${free.length} slots khali hain:*`, ""];
  for (const b of free) {
    const used = taken[b.toISOString()] ?? 0;
    lines.push(`🕐 ${timeOnly(b.toISOString())}  (${hours.perBand - used} jagah)`);
  }
  return lines.join("\n");
}

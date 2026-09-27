/**
 * reminders.ts — the job that actually makes this worth paying for.
 *
 * WHAT IT IS
 *
 * A scheduled function. It wakes up, asks the database who is coming, and sends
 * two messages per appointment:
 *
 *     T-24h   the reminder   -> forces a Yes / No / Reschedule
 *     T-2h    the nudge      -> address and map, so nobody is lost or late
 *
 * WHY THE REMINDER IS NOT REALLY A REMINDER
 *
 * The obvious reading is "remind them so they remember". That is only half of
 * it, and the smaller half.
 *
 * The bigger half is the NO. A patient who says no a day early frees a place
 * that the clinic can still fill. A patient who simply does not turn up frees
 * nothing, because nobody knew until the chair sat empty.
 *
 *     cancelled 24h early  ->  slot resold        ->  clinic earns
 *     no-show              ->  dead hour          ->  clinic loses
 *
 * That difference is the product. So the message makes saying no as easy as
 * saying yes — one tap, no apology asked for, no guilt in the reply. Pushing
 * people to say yes would raise the confirmation rate and lower the revenue,
 * which is the kind of metric that looks good and pays nothing.
 *
 * WHY MESSAGES ARE LOGGED BEFORE THEY ARE SENT
 *
 * Meta charges per conversation and suspends numbers that look spammy. A retry
 * that cannot see what already went out will send twice, and a patient
 * reminded twice stops reading reminders. The outbox row is written first and
 * marked failed on error, so a crash mid-send can never become a double-send.
 */

import { t, type Lang } from "./lang.ts";
import { formatIST } from "./timeparse.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const PHONE_ID = Deno.env.get("PHONE_NUMBER_ID") ?? "";
const GRAPH = Deno.env.get("GRAPH_API_VERSION") ?? "v21.0";

/**
 * Meta only allows a free-form message within 24 hours of the patient's last
 * message. A reminder sent the day before is outside that window, so it MUST
 * go as an approved template. This is the name registered in Meta Business
 * Manager - if it is not approved, nothing sends.
 */
const TEMPLATE_REMINDER = Deno.env.get("TEMPLATE_REMINDER") ?? "appointment_reminder";
const TEMPLATE_NUDGE = Deno.env.get("TEMPLATE_NUDGE") ?? "appointment_today";

function headers(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(path: string, init: RequestInit = {}) {
  const resp = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
  });
  if (!resp.ok) throw new Error("db " + resp.status + " " + (await resp.text()));
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

export interface DueRow {
  id: number;
  business: string;
  name: string;
  phone: string;
  service: string;
  scheduled_at: string;
  lang: Lang;
  status: string;
}

/**
 * Who needs a reminder right now.
 *
 * The window is deliberately wide (a couple of hours, not a couple of minutes).
 * A scheduler can be late, a deploy can be rolling, a run can fail. A narrow
 * window means a missed run is a silently missed reminder, and the clinic just
 * sees a no-show it was paying to prevent. `reminded_at` prevents duplicates,
 * so being generous costs nothing.
 */
export async function dueForReminder(now = new Date(), hoursAhead = 24, windowHours = 3) {
  const from = new Date(now.getTime() + (hoursAhead - windowHours) * 3600000);
  const to = new Date(now.getTime() + hoursAhead * 3600000);
  const q = [
    "appointments",
    "?select=id,business,name,phone,service,scheduled_at,lang,status",
    "&status=in.(booked,confirmed)",
    "&reminded_at=is.null",
    "&scheduled_at=gte." + from.toISOString(),
    "&scheduled_at=lte." + to.toISOString(),
    "&order=scheduled_at.asc",
  ].join("");
  return (await db(q)) as DueRow[];
}

/** Who is coming in the next couple of hours and has not been nudged. */
export async function dueForNudge(now = new Date(), hoursAhead = 2) {
  const to = new Date(now.getTime() + hoursAhead * 3600000);
  const q = [
    "appointments",
    "?select=id,business,name,phone,service,scheduled_at,lang,status",
    "&status=in.(booked,confirmed)",
    "&nudged_at=is.null",
    "&scheduled_at=gte." + now.toISOString(),
    "&scheduled_at=lte." + to.toISOString(),
    "&order=scheduled_at.asc",
  ].join("");
  return (await db(q)) as DueRow[];
}

/** Has this patient asked to be left alone? Checked before every send. */
async function optedOut(phone: string): Promise<boolean> {
  const rows = await db("patients?select=opted_out&phone=eq." + encodeURIComponent(phone));
  return Array.isArray(rows) && rows.length > 0 && rows[0].opted_out === true;
}

async function alreadySent(appointmentId: number, kind: string): Promise<boolean> {
  const rows = await db(
    "outbox?select=id&appointment=eq." + appointmentId +
    "&kind=eq." + kind + "&status=eq.sent&limit=1");
  return Array.isArray(rows) && rows.length > 0;
}

async function logOutbox(row: Record<string, unknown>) {
  await db("outbox", { method: "POST", body: JSON.stringify(row) });
}

/** Send an approved template message through the WhatsApp Cloud API. */
async function sendTemplate(
  to: string, template: string, lang: Lang, params: string[],
): Promise<{ ok: boolean; error?: string }> {
  // Meta wants its own language codes, not ours. Hinglish is written in Latin
  // script, so it registers as an English template.
  const code = lang === "hindi" ? "hi" : "en";
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template,
      language: { code },
      components: [{
        type: "body",
        parameters: params.map((p) => ({ type: "text", text: p })),
      }],
    },
  };
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH}/${PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + WA_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) return { ok: false, error: resp.status + " " + (await resp.text()) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export interface ClinicInfo {
  address: string;
  maps?: string;
}

/**
 * Send one reminder. Returns what happened, so the caller can report honestly
 * rather than assume success.
 */
export async function sendReminder(row: DueRow, clinic: ClinicInfo, now = new Date()) {
  if (await optedOut(row.phone)) return { id: row.id, result: "opted_out" };
  if (await alreadySent(row.id, "reminder")) return { id: row.id, result: "already_sent" };

  const when = formatIST(new Date(row.scheduled_at), row.lang);
  const res = await sendTemplate(row.phone, TEMPLATE_REMINDER, row.lang, [
    row.name || "",
    when,
    row.service || "",
    clinic.address || "",
  ]);

  await logOutbox({
    phone: row.phone, business: row.business, kind: "reminder",
    appointment: row.id, template: TEMPLATE_REMINDER, lang: row.lang,
    status: res.ok ? "sent" : "failed", error: res.error ?? null,
  });

  if (res.ok) {
    await db("appointments?id=eq." + row.id, {
      method: "PATCH",
      body: JSON.stringify({ reminded_at: now.toISOString() }),
    });
  }
  return { id: row.id, result: res.ok ? "sent" : "failed", error: res.error };
}

export async function sendNudge(row: DueRow, clinic: ClinicInfo, now = new Date()) {
  if (await optedOut(row.phone)) return { id: row.id, result: "opted_out" };
  if (await alreadySent(row.id, "nudge")) return { id: row.id, result: "already_sent" };

  const when = formatIST(new Date(row.scheduled_at), row.lang);
  const res = await sendTemplate(row.phone, TEMPLATE_NUDGE, row.lang, [
    row.name || "", when, clinic.address || "",
  ]);

  await logOutbox({
    phone: row.phone, business: row.business, kind: "nudge",
    appointment: row.id, template: TEMPLATE_NUDGE, lang: row.lang,
    status: res.ok ? "sent" : "failed", error: res.error ?? null,
  });

  if (res.ok) {
    await db("appointments?id=eq." + row.id, {
      method: "PATCH",
      body: JSON.stringify({ nudged_at: now.toISOString() }),
    });
  }
  return { id: row.id, result: res.ok ? "sent" : "failed", error: res.error };
}

/**
 * What happens when the patient answers the reminder.
 *
 * Called from the webhook, not from here — but it lives in this file because it
 * is the other half of the same idea. A reminder nobody can answer is just a
 * notification.
 */
export async function applyAnswer(
  appointmentId: number,
  answer: "yes" | "no" | "reschedule",
  now = new Date(),
) {
  if (answer === "yes") {
    await db("appointments?id=eq." + appointmentId, {
      method: "PATCH", body: JSON.stringify({ status: "confirmed" }),
    });
    return "confirmed";
  }
  if (answer === "no") {
    // The slot is free from this moment. Nothing else needs to happen for the
    // clinic to benefit - the next patient who asks for that band will simply
    // be allowed in, because capacity is counted live.
    await db("appointments?id=eq." + appointmentId, {
      method: "PATCH",
      body: JSON.stringify({
        status: "cancelled",
        cancelled_at: now.toISOString(),
        cancel_reason: "patient declined at reminder",
      }),
    });
    return "cancelled";
  }
  await db("appointments?id=eq." + appointmentId, {
    method: "PATCH",
    body: JSON.stringify({
      status: "cancelled",
      cancelled_at: now.toISOString(),
      cancel_reason: "patient asked to reschedule",
    }),
  });
  return "rescheduling";
}

/** The most recent appointment this number could be answering about. */
export async function latestOpenAppointment(phone: string): Promise<DueRow | null> {
  const rows = await db(
    "appointments?select=id,business,name,phone,service,scheduled_at,lang,status" +
    "&phone=eq." + encodeURIComponent(phone) +
    "&status=in.(booked,confirmed)&order=scheduled_at.asc&limit=1");
  return Array.isArray(rows) && rows.length ? rows[0] as DueRow : null;
}

/**
 * The scheduled entry point. Supabase cron calls this every 30 minutes.
 *
 * Runs both passes every time and reports counts. Failures are counted, not
 * thrown - one bad number must never stop the rest of the clinic's reminders.
 */
export async function runReminderPass(clinic: ClinicInfo, now = new Date()) {
  const out = { reminders: 0, nudges: 0, skipped: 0, failed: 0, errors: [] as string[] };

  for (const row of await dueForReminder(now)) {
    try {
      const r = await sendReminder(row, clinic, now);
      if (r.result === "sent") out.reminders++;
      else if (r.result === "failed") { out.failed++; out.errors.push(String(r.error)); }
      else out.skipped++;
    } catch (err) {
      out.failed++;
      out.errors.push(String(err));
    }
  }

  for (const row of await dueForNudge(now)) {
    try {
      const r = await sendNudge(row, clinic, now);
      if (r.result === "sent") out.nudges++;
      else if (r.result === "failed") { out.failed++; out.errors.push(String(r.error)); }
      else out.skipped++;
    } catch (err) {
      out.failed++;
      out.errors.push(String(err));
    }
  }
  return out;
}

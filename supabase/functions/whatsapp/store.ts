/**
 * store.ts — Postgres persistence for sessions and appointments.
 *
 * Replaces two things the Flask MVP kept locally: the in-memory SESSIONS dict
 * (gone, because Edge Functions are stateless between requests) and
 * appointments.json (gone, because it was wiped on every redeploy).
 *
 * Talks to PostgREST with the service_role key, which bypasses RLS. Plain
 * fetch, no SDK, so the function bundle stays tiny and dependency-free.
 *
 * ⚖️  DPDP-SAFE BY DESIGN (India's DPDP Act, 2023): only name, WhatsApp number,
 *     chosen service category and a preferred time are stored. Never medical
 *     details (symptoms, diagnosis, reports, prescriptions). Keep it that way.
 */

import { type Session } from "./bot.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// A half-finished booking older than this is treated as abandoned, so a
// customer returning next week starts fresh instead of being asked for a time.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** Load this customer's booking state, or a blank one if absent/stale. */
export async function getSession(phone: string): Promise<Session> {
  const fresh: Session = { phone };
  try {
    const url = SUPABASE_URL + "/rest/v1/sessions?phone=eq." +
      encodeURIComponent(phone) + "&select=state,updated_at";
    const resp = await fetch(url, { headers: headers() });
    if (!resp.ok) return fresh;

    const rows = await resp.json();
    if (!Array.isArray(rows) || !rows.length) return fresh;

    const age = Date.now() - new Date(rows[0].updated_at).getTime();
    if (age > SESSION_TTL_MS) return fresh;

    return { ...(rows[0].state ?? {}), phone };
  } catch (err) {
    console.error("[session load]", err);
    return fresh;
  }
}

/** Persist the customer's state. `_booked` is transient, so it is not stored. */
export async function saveSession(phone: string, session: Session): Promise<void> {
  const { _booked: _ignored, ...state } = session;
  try {
    const resp = await fetch(SUPABASE_URL + "/rest/v1/sessions", {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ phone, state, updated_at: new Date().toISOString() }),
    });
    if (!resp.ok) console.error("[session save]", resp.status, await resp.text());
  } catch (err) {
    console.error("[session save]", err);
  }
}

/**
 * Append one appointment/lead and return it. This is the "money" part of a
 * front-desk bot: every booking becomes a saved lead the business can call
 * back. Never throws — a failed insert must not cost the customer their reply,
 * and the owner still gets the WhatsApp alert.
 */
export async function saveAppointment(
  record: Record<string, string>,
): Promise<Record<string, string>> {
  const row: Record<string, unknown> = {
    business: record.business,
    name: record.name,
    phone: record.phone,
    service: record.service,
    slot_time: record.time, // "time" is a SQL type name, so the column is slot_time
    // The parsed instant. Everything downstream depends on it: without a real
    // timestamp nothing can answer "who is coming tomorrow", and that question
    // IS the reminder. Null is allowed and meaningful - it says the bot could
    // not understand the time, so a human still has to call.
    scheduled_at: record.scheduled_at || null,
    // What the patient actually typed, kept verbatim. If the parser got it
    // wrong, this is the only way anyone can ever tell.
    raw_time: record.raw_time || record.time || null,
    lang: record.lang || "hinglish",
  };
  try {
    const resp = await fetch(SUPABASE_URL + "/rest/v1/appointments", {
      method: "POST",
      headers: headers({ Prefer: "return=minimal" }),
      body: JSON.stringify(row),
    });
    if (!resp.ok) console.error("[appointment save]", resp.status, await resp.text());
  } catch (err) {
    console.error("[appointment save]", err);
  }
  return { ...record, created_at: new Date().toISOString() };
}

/**
 * The patient's saved language, or null if this is a new number.
 *
 * Looked up on every message so the choice survives between conversations. A
 * patient asked their own language on every visit stops trusting the thing.
 */
export async function getPatientLang(phone: string): Promise<string | null> {
  try {
    const resp = await fetch(
      SUPABASE_URL + "/rest/v1/patients?select=lang&phone=eq." + encodeURIComponent(phone),
      { headers: headers() },
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    return Array.isArray(rows) && rows.length ? rows[0].lang : null;
  } catch {
    return null;   // never block a reply over a lookup
  }
}

/** Remember this number and the language it chose. */
export async function savePatient(
  phone: string, lang: string, name?: string, business?: string,
): Promise<void> {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/patients", {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        phone, lang, name: name ?? null, business: business ?? null,
        last_seen: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error("[patient save]", err);
  }
}

/**
 * How many patients already sit in each time band, for the days around a date.
 *
 * Returns a map of band-start ISO time to a count, which is exactly what
 * slots.ts needs to decide whether a request fits. Cancelled and no-show rows
 * are excluded on purpose: a cancellation frees its place immediately, and
 * that freeing is the entire point of sending reminders at all.
 */
export async function takenBands(
  from: Date, to: Date, bandMinutes = 30,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const q = "appointments?select=scheduled_at" +
      "&status=in.(booked,confirmed)" +
      "&scheduled_at=gte." + from.toISOString() +
      "&scheduled_at=lte." + to.toISOString();
    const resp = await fetch(SUPABASE_URL + "/rest/v1/" + q, { headers: headers() });
    if (!resp.ok) return out;
    for (const r of await resp.json()) {
      if (!r.scheduled_at) continue;
      const d = new Date(r.scheduled_at);
      const mins = d.getHours() * 60 + d.getMinutes();
      const snapped = Math.floor(mins / bandMinutes) * bandMinutes;
      const band = new Date(d);
      band.setHours(Math.floor(snapped / 60), snapped % 60, 0, 0);
      const key = band.toISOString();
      out[key] = (out[key] ?? 0) + 1;
    }
  } catch (err) {
    console.error("[taken bands]", err);
  }
  return out;
}

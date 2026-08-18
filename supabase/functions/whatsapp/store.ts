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
  const row = {
    business: record.business,
    name: record.name,
    phone: record.phone,
    service: record.service,
    slot_time: record.time, // "time" is a SQL type name, so the column is slot_time
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

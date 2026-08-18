-- Schema for the WhatsApp front-desk bot on Supabase.
--
-- Two tables replace what the Flask MVP kept on disk / in memory:
--   sessions     — per-customer booking state (was an in-memory dict in app.py;
--                  it had to move because Edge Functions are stateless)
--   appointments — captured bookings/leads (was appointments.json, which was
--                  wiped on every redeploy)
--
-- DPDP-safe by design: only name / phone / chosen service / preferred time.
-- Never add symptom, diagnosis, report or prescription columns here.

create table if not exists public.sessions (
  phone       text primary key,
  state       jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.appointments (
  id          bigint generated always as identity primary key,
  business    text,
  name        text,
  phone       text,
  service     text,
  slot_time   text,          -- free text, e.g. "Kal shaam 5 baje" ("time" is a type name)
  created_at  timestamptz not null default now()
);

create index if not exists appointments_created_at_idx on public.appointments (created_at desc);

-- The Edge Function talks to these with the service_role key, which bypasses
-- RLS. RLS stays ON so nothing is readable with the public anon key.
alter table public.sessions     enable row level security;
alter table public.appointments enable row level security;

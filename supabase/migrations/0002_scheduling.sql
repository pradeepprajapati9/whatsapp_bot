-- Scheduling, language and status — what turns a chatbot into a product.
--
-- WHY THIS MIGRATION EXISTS
--
-- 0001 stored the appointment time as free text ("Kal shaam 5 baje"). That is
-- fine for showing a receptionist what the patient said, and useless for
-- everything else, because you cannot ask a string "who is coming tomorrow".
--
-- Reminders are the entire value of this product — a clinic pays to stop
-- no-shows, not to have its FAQs answered — and a reminder job has to run a
-- query like "every appointment between 24 and 25 hours from now". Against a
-- text column that query cannot be written at all.
--
-- So the free text stays (it is what the patient actually typed, and the
-- receptionist should see it), and a real timestamp sits beside it.
--
-- DPDP-safe, unchanged: name, phone, chosen service, time. Never a symptom,
-- diagnosis, report or prescription. Do not add one.

-- ---------------------------------------------------------------- appointments
alter table public.appointments
  -- The parsed time. Null means the bot could not understand what the patient
  -- typed, which is a real case and must not be silently treated as "no
  -- appointment" — the receptionist still has to call them.
  add column if not exists scheduled_at  timestamptz,

  -- booked      patient asked, nobody has confirmed
  -- confirmed   patient said yes to the reminder
  -- cancelled   patient said no  -> THE SLOT IS FREE, and that is the point
  -- no_show     did not turn up  -> the number the clinic is paying to reduce
  -- done        attended
  add column if not exists status        text not null default 'booked',

  -- Which language this patient is comfortable in. Stored per appointment as
  -- well as per patient, so a reminder sent next week still goes out in the
  -- language they actually chose.
  add column if not exists lang          text not null default 'hinglish',

  -- Reminder bookkeeping. Timestamps rather than booleans, so a duplicate send
  -- is impossible and it is always visible WHEN something went out.
  add column if not exists reminded_at   timestamptz,
  add column if not exists nudged_at     timestamptz,
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancel_reason text,

  -- What the patient originally typed, kept verbatim. If the parser got it
  -- wrong, this is the only way anyone can tell.
  add column if not exists raw_time      text;

-- The reminder job's query: upcoming, not yet reminded, not cancelled. Without
-- this index it is a full scan every few minutes, forever.
create index if not exists appointments_due_idx
  on public.appointments (scheduled_at)
  where status in ('booked', 'confirmed');

create index if not exists appointments_phone_idx
  on public.appointments (phone, created_at desc);


-- ---------------------------------------------------------------- patients
-- One row per WhatsApp number. Exists for one reason: the language choice has
-- to survive between conversations. Asking again on every visit is exactly the
-- kind of small rudeness that makes software feel foreign.
create table if not exists public.patients (
  phone       text primary key,
  name        text,
  lang        text not null default 'hinglish',
  business    text,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  -- They asked not to be messaged. Honour it forever, across every clinic.
  opted_out   boolean not null default false
);

alter table public.patients enable row level security;


-- ---------------------------------------------------------------- outbox
-- Every outbound message, logged.
--
-- Three reasons, all learned the expensive way by people who skipped it:
--   1. WhatsApp charges per conversation — without a log you cannot tell a
--      clinic what its bill is for.
--   2. Meta suspends numbers that look spammy. A log is the only defence.
--   3. A retry that cannot see what already went out will send twice, and a
--      patient reminded twice about the same appointment stops reading them.
create table if not exists public.outbox (
  id          bigint generated always as identity primary key,
  phone       text not null,
  business    text,
  kind        text not null,           -- reminder | nudge | followup | reply
  appointment bigint references public.appointments(id),
  template    text,
  lang        text,
  status      text not null default 'sent',   -- sent | failed
  error       text,
  sent_at     timestamptz not null default now()
);

create index if not exists outbox_appointment_idx on public.outbox (appointment, kind);
alter table public.outbox enable row level security;

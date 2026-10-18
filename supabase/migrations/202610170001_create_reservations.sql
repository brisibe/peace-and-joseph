create table public.reservations (
  submission_id uuid primary key,
  received_at timestamptz not null default now(),
  name text not null check (length(btrim(name)) between 1 and 100),
  email text not null check (length(email) <= 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  phone text not null default '' check (phone = '' or (
    length(phone) <= 32 and phone ~ '^\+?[0-9 ()-]+$'
    and length(regexp_replace(phone, '[^0-9]', '', 'g')) between 7 and 15
  )),
  attending text not null check (attending in ('yes', 'no')),
  guests smallint not null,
  message text not null default '' check (length(message) <= 1000),
  constraint attendance_party_size check (
    (attending = 'yes' and guests between 1 and 4) or (attending = 'no' and guests = 0)
  )
);

alter table public.reservations enable row level security;
revoke all on table public.reservations from public, anon, authenticated;
grant select, insert, update, delete on table public.reservations to service_role;
-- No visitor policies: all public submissions pass through the validating Edge Function.

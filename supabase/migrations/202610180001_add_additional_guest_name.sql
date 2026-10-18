-- Nullable for historical reservations, which have no recorded additional name.
alter table public.reservations
  add column additional_guest_name text,
  add constraint additional_guest_name_length check (
    additional_guest_name is null or (
      additional_guest_name ~ '[^[:space:]]' and length(additional_guest_name) between 1 and 100
    )
  );
-- Conditional requiredness is enforced by the receiver for new submissions.
-- Retain historical party sizes and the existing RLS/access restrictions.

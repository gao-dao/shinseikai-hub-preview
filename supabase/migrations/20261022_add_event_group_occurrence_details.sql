-- Add optional occurrence metadata without updating existing event groups.
begin;

alter table public.event_groups
  add column city text null,
  add column start_date date null,
  add column end_date date null,
  add constraint event_groups_city_length
    check (city is null or char_length(city) between 1 and 100),
  add constraint event_groups_date_range
    check (
      (start_date is null and end_date is null)
      or (
        start_date is not null and end_date is not null
        and start_date <= end_date
      )
    );

commit;

-- ─────────────────────────────────────────────────────────────
-- Trips: pack a capsule wardrobe per trip, then build outfits
-- from just those items. Run ONCE in Supabase → SQL Editor.
-- Mirrors the RLS pattern used by items / outfits.
-- item_ids / outfit_ids are uuid[] holding items.id / outfits.id
-- (array columns, same style as outfits.item_ids — not FK-enforced).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.trips (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  item_ids    uuid[] not null default '{}',
  outfit_ids  uuid[] not null default '{}',
  created_at  timestamptz not null default now()
);

alter table public.trips enable row level security;

create policy "trips_select_own" on public.trips
  for select using (auth.uid() = user_id);
create policy "trips_insert_own" on public.trips
  for insert with check (auth.uid() = user_id);
create policy "trips_update_own" on public.trips
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trips_delete_own" on public.trips
  for delete using (auth.uid() = user_id);

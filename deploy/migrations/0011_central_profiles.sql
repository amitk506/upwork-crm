-- ============================================================================
-- 0011_central_profiles.sql — Upwork profiles belong to the PORTAL, not to a user
-- ============================================================================
-- The agency runs 7–8 Upwork profiles. The portal holds all of them centrally,
-- and the owner grants each team member access to the profiles or the specific
-- chats they handle. A member signs into the portal and works; they never touch
-- an Upwork login of their own.
--
-- Each profile is still authorized by whoever holds that Upwork account — OAuth
-- has no other way in. What changes is that the resulting connection belongs to
-- the portal rather than to one portal user, so access can be granted onward.
--
-- send_requires_approval is per profile. It defaulted TRUE here; migration 0025
-- makes it opt-in and switches it off, because the default inverted what the
-- portal is for — see that file for the reasoning.
--
-- The consideration behind the original default still stands and is worth keeping
-- written down: a reply leaving under someone's profile that they have not read is
-- a decision the account holder is making about their own Upwork account. What
-- makes it theirs to make is that every profile is authorized by its holder
-- through OAuth — they consent to the portal acting for them, and can revoke it —
-- rather than by handing over a password. Who typed each message is recorded and
-- shown in the thread, so the trail exists either way. Owners who want a review
-- step for a particular profile turn it back on there.
-- ============================================================================

create table if not exists public.upwork_profiles (
  id                uuid primary key default gen_random_uuid(),

  label             text not null,          -- what the team calls it, e.g. "Gayatri"
  upwork_user_name  text,
  upwork_user_id    text,
  org_uid           text not null default '',
  org_name          text,
  org_role          text,

  access_token_ct   text not null,
  access_token_iv   text not null,
  access_token_tag  text not null,
  refresh_token_ct  text not null,
  refresh_token_iv  text not null,
  refresh_token_tag text not null,
  key_version       smallint not null default 1,

  access_token_expires_at timestamptz,
  refresh_after     timestamptz,
  refreshed_at      timestamptz,
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  connect_error     text,
  consecutive_failures smallint not null default 0,
  circuit_open_until timestamptz,

  -- TRUE: drafts must be approved by someone holding this profile before send.
  send_requires_approval boolean not null default true,

  connected_by      uuid references public.app_users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (org_uid, upwork_user_id)
);

drop trigger if exists upwork_profiles_touch on public.upwork_profiles;
create trigger upwork_profiles_touch
  before update on public.upwork_profiles
  for each row execute function public.touch_updated_at();

comment on column public.upwork_profiles.send_requires_approval is
  'TRUE keeps the profile holder as the actual sender. FALSE lets a granted member send under this profile directly — permitted by this portal, but not by Upwork''s account-sharing rule.';

-- ---------------------------------------------------------------------------
-- Grants: whole profile, or one conversation
-- ---------------------------------------------------------------------------
create table if not exists public.profile_grants (
  profile_id uuid not null references public.upwork_profiles(id) on delete cascade,
  user_id    uuid not null references public.app_users(id) on delete cascade,
  can_send   boolean not null default true,
  granted_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (profile_id, user_id)
);

create table if not exists public.room_grants (
  room_id    text not null,
  user_id    uuid not null references public.app_users(id) on delete cascade,
  profile_id uuid not null references public.upwork_profiles(id) on delete cascade,
  can_send   boolean not null default true,
  granted_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists profile_grants_user_idx on public.profile_grants (user_id);
create index if not exists room_grants_user_idx on public.room_grants (user_id);

comment on table public.room_grants is
  'Access to one conversation via one profile — for members who handle specific chats rather than a whole profile.';

-- ---------------------------------------------------------------------------
-- Which profile can reach which room
-- ---------------------------------------------------------------------------
-- Replaces per-user room_access: reachability is a property of the PROFILE that
-- synced the room, not of a portal user.
create table if not exists public.room_profiles (
  room_id       text not null,
  profile_id    uuid not null references public.upwork_profiles(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (room_id, profile_id)
);

create index if not exists room_profiles_profile_idx on public.room_profiles (profile_id);

-- ---------------------------------------------------------------------------
-- Migrate the existing per-user connections into portal-owned profiles
-- ---------------------------------------------------------------------------
insert into public.upwork_profiles (
  label, upwork_user_name, upwork_user_id, org_uid, org_name, org_role,
  access_token_ct, access_token_iv, access_token_tag,
  refresh_token_ct, refresh_token_iv, refresh_token_tag,
  key_version, access_token_expires_at, refresh_after, refreshed_at,
  last_used_at, connected_by
)
select
  coalesce(c.org_name, u.full_name, u.email),
  c.upwork_user_name, c.upwork_user_id, c.org_uid, c.org_name, c.org_role,
  c.access_token_ct, c.access_token_iv, c.access_token_tag,
  c.refresh_token_ct, c.refresh_token_iv, c.refresh_token_tag,
  c.key_version, c.access_token_expires_at, c.refresh_after, c.refreshed_at,
  c.last_used_at, c.user_id
from public.upwork_connections c
join public.app_users u on u.id = c.user_id
where c.revoked_at is null
  -- ONE-SHOT. deploy.sh replays every migration on each deploy, and without this
  -- guard the seed runs again every time — so a profile an owner deliberately
  -- removed reappeared on the next deploy, rebuilt from the legacy connection
  -- row. `on conflict do nothing` does not help once the row is gone: there is
  -- nothing left to conflict with. Seeding only into an empty table is what
  -- "migrate the existing connections" actually meant.
  and not exists (select 1 from public.upwork_profiles)
on conflict (org_uid, upwork_user_id) do nothing;

-- Whoever connected a profile keeps full access to it.
insert into public.profile_grants (profile_id, user_id, can_send, granted_by)
select p.id, p.connected_by, true, p.connected_by
from public.upwork_profiles p
where p.connected_by is not null
on conflict do nothing;

-- Carry room reachability across.
insert into public.room_profiles (room_id, profile_id, first_seen_at, last_seen_at)
select ra.room_id, p.id, ra.first_seen_at, ra.last_seen_at
from public.room_access ra
join public.upwork_connections c on c.user_id = ra.user_id
join public.upwork_profiles p
  on p.org_uid = c.org_uid and p.upwork_user_id is not distinct from c.upwork_user_id
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Access predicates
-- ---------------------------------------------------------------------------

-- Every profile this user may act through in a given room.
create or replace function public.profiles_for_room(p_room_id text, p_user_id uuid default auth.uid())
returns table (profile_id uuid, can_send boolean)
language sql
stable
security definer
set search_path = public
as $$
  -- granted the whole profile, and that profile reaches this room
  select pg.profile_id, pg.can_send
  from public.profile_grants pg
  join public.room_profiles rp on rp.profile_id = pg.profile_id
  where pg.user_id = p_user_id and rp.room_id = p_room_id
  union
  -- granted this specific conversation
  select rg.profile_id, rg.can_send
  from public.room_grants rg
  where rg.user_id = p_user_id and rg.room_id = p_room_id;
$$;

create or replace function public.has_room_grant(p_room_id text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles_for_room(p_room_id, p_user_id));
$$;

-- ---------------------------------------------------------------------------
-- Visibility now follows grants as well as assignment
-- ---------------------------------------------------------------------------
create or replace function public.can_see_target(p_type public.assignment_target, p_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    -- explicit grant always wins: this is the chat they were given
    when p_type = 'room' and public.has_room_grant(p_id) then true

    else case public.inbox_scope()
      when 'all' then true

      when 'assigned' then exists (
        select 1 from public.assignments a
        where a.target_type = p_type and a.target_id = p_id and a.assigned_to = auth.uid()
      )

      when 'assigned_or_unassigned' then
        not exists (
          select 1 from public.assignments a
          where a.target_type = p_type and a.target_id = p_id
        )
        or exists (
          select 1 from public.assignments a
          where a.target_type = p_type and a.target_id = p_id and a.assigned_to = auth.uid()
        )

      else false
    end
  end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.upwork_profiles enable row level security;
alter table public.profile_grants  enable row level security;
alter table public.room_grants     enable row level security;
alter table public.room_profiles   enable row level security;

-- upwork_profiles holds ciphertext: NO policies, service_role only, same as
-- the old upwork_connections table.

drop policy if exists profile_grants_select on public.profile_grants;
create policy profile_grants_select on public.profile_grants
  for select to authenticated
  using (user_id = auth.uid() or public.is_staff());

drop policy if exists room_grants_select on public.room_grants;
create policy room_grants_select on public.room_grants
  for select to authenticated
  using (user_id = auth.uid() or public.is_staff());

drop policy if exists room_profiles_select on public.room_profiles;
create policy room_profiles_select on public.room_profiles
  for select to authenticated
  using (public.can_see_target('room', room_id));

-- ---------------------------------------------------------------------------
-- Safe projection for the UI: which profiles exist, without any ciphertext
-- ---------------------------------------------------------------------------
-- Drop before create, never CREATE OR REPLACE. deploy.sh replays every migration
-- on every run, and CREATE OR REPLACE VIEW cannot add, drop or reorder columns —
-- so the moment a later migration reshapes this view, the replay of THIS file
-- fails with "cannot drop columns from view" and every migration after it is
-- skipped. That happened: 0025 appended a column to v_room_profiles, 0013 then
-- failed on every deploy, and the guards in 0020 stopped being applied — leaving
-- five views readable without authentication.
drop view if exists public.v_profiles;

create view public.v_profiles as
  select
    p.id,
    p.label,
    p.upwork_user_name,
    p.org_name,
    p.org_role,
    p.send_requires_approval,
    (p.revoked_at is null) as is_active,
    p.connect_error,
    p.last_used_at,
    p.refreshed_at,
    (select count(*) from public.room_profiles rp where rp.profile_id = p.id) as room_count,
    (select count(*) from public.profile_grants pg where pg.profile_id = p.id) as member_count
  from public.upwork_profiles p;

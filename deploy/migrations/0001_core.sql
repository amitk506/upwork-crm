-- ============================================================================
-- 0001_core.sql — extensions, roles, portal identity, RLS helper functions
-- ============================================================================
-- Portal identity is deliberately SEPARATE from Upwork identity:
--   app_users        = who can log into this portal      (Supabase Auth)
--   upwork_connections = their individual Upwork OAuth grant (see 0003)
-- One portal user maps to at most one Upwork account. Never a shared token —
-- Upwork prohibits account sharing outright. See docs/01-research-findings.md §3.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- owner   — full control, only role that can change roles or remove members
-- manager — sees every room/job/contract, assigns work, cannot change roles
-- bidder  — sees only what is assigned to them, plus unassigned inbound
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('owner', 'manager', 'bidder');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- app_users — portal accounts, 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table if not exists public.app_users (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text        not null unique,
  full_name      text,
  avatar_url     text,
  role           public.app_role not null default 'bidder',
  is_active      boolean     not null default true,
  -- populated after the user completes the Upwork OAuth consent
  upwork_user_id text unique,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on column public.app_users.upwork_user_id is
  'Upwork user id from list_accounts. Null until the user connects their own Upwork account.';

-- ---------------------------------------------------------------------------
-- updated_at trigger, reused across tables
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_users_touch on public.app_users;
create trigger app_users_touch
  before update on public.app_users
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-provision an app_users row on signup
-- ---------------------------------------------------------------------------
-- The FIRST user to sign up becomes owner (bootstrap); everyone after is a
-- bidder until an owner promotes them.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_first boolean;
begin
  select count(*) = 0 into is_first from public.app_users;

  insert into public.app_users (id, email, full_name, avatar_url, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url',
    case when is_first then 'owner'::public.app_role else 'bidder'::public.app_role end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- RLS helper functions
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so that policies ON app_users can call them without
-- re-entering app_users' own RLS (which would recurse infinitely).
--
-- Named app_user_role(), NOT current_role() — `current_role` is a reserved SQL
-- keyword, and an unqualified reference inside a function would silently
-- resolve to the keyword rather than to this function.
create or replace function public.app_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.app_users where id = auth.uid() and is_active;
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.app_user_role() in ('owner', 'manager'), false);
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.app_user_role() = 'owner', false);
$$;

comment on function public.is_staff() is
  'True for owner and manager — the roles that see all agency data.';

-- ============================================================================
-- 0032_room_contract.sql — keep the contract id Upwork now sends
-- ============================================================================
-- The list_rooms payload changed on 21 Aug 2026. It stopped sending `topic` and
-- `lastVisitedDateTime`, and started sending `contractId` and `contractStatus`.
--
-- That trade is worth taking. `topic` was a free-text job title, and matching it
-- to a proposal by string comparison paired 1 conversation in 335. A contract id
-- is an actual key: it names the engagement a conversation belongs to, which is
-- what "what job is this client talking about" always needed.
-- ============================================================================

alter table public.up_rooms add column if not exists contract_id text;
alter table public.up_rooms add column if not exists contract_status text;

create index if not exists up_rooms_contract_idx on public.up_rooms (contract_id)
  where contract_id is not null;

comment on column public.up_rooms.contract_id is
  'The Upwork contract this conversation belongs to. Present since the Aug 2026 payload change; null on rooms last seen before it.';

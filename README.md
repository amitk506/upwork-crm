# Upwork Inbox Portal

A shared inbox for an agency's Upwork conversations. Every client message across
every profile the agency runs, in one place, with a wait meter on each thread,
assignment and approval, an end-of-day review, and a no-login status board —
without anyone logging into upwork.com directly.

This is the inbox half of a larger portal. Job discovery, proposal drafting and
milestone tracking were removed from this copy on purpose; what remains is
complete on its own.

**Internal use only.** Upwork's API is licensed for personal and internal use;
commercial use and resale are not supported. Keep this single-tenant.

- [docs/01-research-findings.md](docs/01-research-findings.md) — what the Upwork API
  actually supports, the ToS constraints, and why the build is shaped this way
- [docs/02-architecture.md](docs/02-architecture.md) — stack, data model, sync
  strategy, module design, build order

## Status

Live and in daily use at the agency it was built for. Portal auth, roles,
schema, RLS, token vault, per-profile Upwork OAuth, the read-only MCP transport,
the inbox with attachments, the board, approvals, follow-ups, the end-of-day
review and the status board. Migrations 0001–0033. Nothing is blocked on an
Upwork API key: OAuth credentials come from dynamic client registration (see
below).

## What is in it

- **Inbox** — every conversation across every connected profile, newest activity
  first, with who the client is waiting on and for how long. Replies go out
  under the profile the client knows, and the sender's real name is recorded
  internally. Attachments and pasted screenshots work.
- **Wait meter** — counted hours since the client last spoke, with quiet hours
  discounted and a ramp from fresh to breached. Survives the 24-hour mirror
  sweep because the derived state is the portal's own.
- **Assignment and approval** — route a conversation to a teammate; optionally
  require a manager to approve replies from a given profile before they send.
- **Follow-ups** — a date on a thread becomes a reminder on the assignee's
  dashboard.
- **Board** — per-person response performance: who replies fast, who delays.
- **End-of-day review** — conversations that ended a working day unanswered,
  queued for a manager to confirm or dismiss. Skips weekends and the holidays
  your HR system publishes (`HOLIDAYS_URL`).
- **Status board** — a departures-board view of who is waiting, at a secret URL,
  readable without a login and hidden from crawlers.


## Three rules that shape everything

1. **Never a shared Upwork login.** Upwork prohibits account sharing outright.
   Each team member authorizes their own Upwork account once, and the portal acts
   as them. `upwork_connections` holds one encrypted token per person.
2. **The mirror is a cache, not an archive.** Caching Upwork responses beyond 24
   hours breaches the ToS. Every `up_*` table carries `fetched_at`, and
   `expire_upwork_mirror()` hard-deletes past the ceiling. Data the portal
   generates itself has no such limit.
3. **Stay visibly inside the limits.** Upwork's automation policy can restrict an
   account for traffic that merely *looks* like runaway automation. The margins
   below are deliberate.

## Account safety

The risk this design takes seriously is not a bug — it is Upwork restricting the
agency's account. Five gates, in the order they fire:

| # | Gate | Where |
|---|---|---|
| 1 | **Tool allowlist.** A tool absent from `TOOL_POLICY` cannot be called at all. | `lib/upwork/limits.ts` |
| 2 | **Write guard.** Mutating tools refuse unless `UPWORK_ALLOW_WRITES=true`. | `lib/upwork/mcp-client.ts` |
| 3 | **Daily budget.** Refuses past 30k/day; background work stops at 20k. | `lib/upwork/rate-limiter.ts` |
| 4 | **Token bucket.** 6 req/s against Upwork's 10 req/s per-IP ceiling. | `lib/upwork/rate-limiter.ts` |
| 5 | **Circuit breaker.** 3 consecutive failures pauses that user for 5 minutes. | `lib/upwork/connections.ts` |

Gates 1–3 run **before any network request is constructed**, so a refusal costs
Upwork nothing and cannot itself look like abuse.

| Limit | Upwork published | This portal |
|---|---|---|
| Requests/second (per IP) | 10 | **6** |
| Requests/day | 40,000 | **30,000** |
| Background sync cutoff | — | **20,000** |
| Cache max age | 24h (ToS ceiling) | **12h** |

**Phase 2 is read-only.** `send_message`, `manage_proposals`, `submit_milestones`
and `confirm_draft` are defined but blocked. Nothing in this codebase can post,
bid, or message on Upwork today. Nothing polls in the background either — every
request so far is one a signed-in person triggered.

`npm run test:limits` asserts the self-imposed limits stay strictly under the
published ones, so a future edit cannot quietly raise them. `/ops` (managers and
owners) shows live spend, posture and the allow/block lists.

### If you later enable writes

Set `UPWORK_ALLOW_WRITES=true` *only* alongside a human confirmation step in the
UI. Upwork's policy names proposal and invite spam explicitly. Keep every write
human-initiated: no auto-apply, no auto-send.

## Run it locally

The portal needs a Postgres, a GoTrue and a PostgREST behind one URL — the same
three the server runs. One script stands them up in Docker, applies the schema
and creates the first owner:

```bash
npm install
OWNER_EMAIL=you@example.com AGENCY_NAME="Your Agency" ./scripts/dev-stack.sh up
npm run dev                    # → http://localhost:3000
```

It prints the owner's password once. `./scripts/dev-stack.sh down` removes
everything. Connecting an Upwork profile still needs OAuth credentials — see
below — but every screen renders without one.

## Setup

```bash
npm install
cp .env.example .env.local
openssl rand -base64 32        # → TOKEN_ENCRYPTION_KEY
```

Fill in `.env.local` from your Supabase project settings, then apply the schema —
either paste `supabase/migrations/*.sql` into the Supabase SQL editor in order, or:

```bash
npx supabase link --project-ref <ref>
npm run db:push
```

```bash
npm run dev
```

**The first person to sign in becomes the owner.** Everyone after is a bidder
until an owner promotes them on `/team`.

### Upwork OAuth credentials

No API key application needed — Upwork's MCP server exposes a live RFC 7591
dynamic client registration endpoint that issues credentials instantly:

```bash
node scripts/register-oauth-client.mjs https://your-host/api/upwork/callback
```

Registrations **cannot be deleted** (`DELETE` returns 405), so run this once per
environment. Full reasoning in [docs/01-research-findings.md §5](docs/01-research-findings.md).

## Verifying the schema

Supabase offers no free local way to exercise RLS, so `npm run db:test` stands up
a throwaway Postgres in Docker with a minimal `auth` shim and runs
`supabase/tests/rls_test.sql` against it:

```bash
npm run db:test
```

18 checks covering the owner-bootstrap trigger, per-role row visibility,
privilege-escalation attempts, the last-owner guard, TTL expiry and the rate
budget ledger. Run it after touching anything in `supabase/migrations/`.

## Layout

```
src/
  proxy.ts                 session refresh + route gating
  lib/
    env.ts                 zod-validated env, client/server split
    crypto.ts              AES-256-GCM seal/open for OAuth tokens
    auth.ts                requireUser / requireCapability
    permissions.ts         capability-based roles
    activity.ts            append-only audit trail
    wait.ts                the wait meter
    holidays.ts            HR holiday list (optional)
    reply-misses.ts        end-of-day check
    upwork/
      limits.ts            Upwork's limits + ours + the tool allowlist
      rate-limiter.ts      token bucket + daily budget
      oauth.ts             PKCE authorize / exchange / refresh / revoke
      profiles.ts          the token vault and per-profile acting
      mcp-client.ts        JSON-RPC + the safety gates
      transport-mcp.ts     UpworkTransport over MCP
      sync.ts              the unattended mirror sync
      direction.ts, alternation.ts, reply-state.ts
                           who said what, when Upwork will not say
      attachments.ts       attachment parsing and the upload chain
  app/
    inbox/                 the inbox and a conversation
    board/, approvals/, reviews/, activity/
    status/[token]/        the no-login status board
    profiles/, team/, ops/, account/
    api/sync/              the unattended tick
supabase/
  migrations/              0001–0033
  tests/rls_test.sql
deploy/                    docker compose, migrations replay, push.sh
scripts/
  register-oauth-client.mjs
  test-db.sh
```

## Security notes

- `SUPABASE_SERVICE_ROLE_KEY` and `TOKEN_ENCRYPTION_KEY` are server-only. `env.ts`
  keeps them out of anything the browser can import.
- `upwork_connections` has RLS enabled and **no policies** — unreachable from the
  browser by construction. Read connection state via `v_connection_status`.
- Tokens are encrypted in Node before they reach Postgres. pgcrypto was rejected
  because passing the key as a SQL parameter risks leaking it into query logs.
- Losing `TOKEN_ENCRYPTION_KEY` means every member must reconnect their Upwork
  account. Back it up somewhere real.
- Role changes are enforced twice — by RLS policy and by the
  `guard_role_changes` trigger. The trigger is deliberately SECURITY INVOKER;
  as SECURITY DEFINER, its `current_user` check would resolve to the function
  owner and wave through every caller.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run check` | typecheck + lint + build |
| `npm run db:test` | Schema and RLS behaviour tests (needs Docker) |
| `npm run test:limits` | Asserts our limits stay under Upwork's published caps |
| `npm run db:push` | Apply migrations via the Supabase CLI |
| `npm run deploy` | rsync to your server and run `deploy/deploy.sh` there (set `DEPLOY_HOST`, `DEPLOY_KEY`) |

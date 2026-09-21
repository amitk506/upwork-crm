# Upwork Agency Portal — Architecture

Companion to [01-research-findings.md](01-research-findings.md). Read that first — the rate
limits and the per-user-auth requirement drive most decisions here.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | **Next.js 16 (App Router) + TypeScript** | Matches every other project in this workspace; RSC keeps the inbox fast |
| DB / Auth | **Supabase (Postgres + RLS)** | Row-level security is exactly the primitive needed for "bidder sees only their assigned rooms" |
| Portal login | Supabase Auth (email + Google) | Portal identity ≠ Upwork identity; kept separate on purpose |
| Upwork link | **OAuth 2.0 per user**, tokens encrypted at rest | Compliance requirement, not a preference |
| Live inbox | **SSE** from a Next.js route handler, fed by the sync worker | Simpler than WebSockets, survives serverless |
| Sync worker | Long-running Node process, same VPS | Needs a stable IP for the per-IP rate budget |
| Upwork transport | **MCP now, GraphQL later — behind one interface** | MCP needs no API key (see research §5); GraphQL is the durable path |
| AI assist | Opus 5 via Anthropic SDK | Cover letters, thread summaries, job triage scoring |

**Deploy target (decided): everything on the Hostinger VPS behind Traefik**, same pattern as
the WhatsApp inbox and Postiz. One fixed IP means exactly one rate-limit bucket to reason
about — which matters, because the 10 req/s ceiling is enforced **per IP, not per user**.
Serverless would rotate IPs, make the budget unaccountable, and risk tripping abuse heuristics.

## Transport abstraction (build this first)

Both routes speak per-user OAuth and return the same domain objects. Everything above the
transport must be ignorant of which one is live:

```ts
interface UpworkTransport {
  listRooms(user: ConnectedUser, opts): Promise<Room[]>
  listMessages(user: ConnectedUser, roomId: string): Promise<Message[]>
  sendMessage(user: ConnectedUser, roomId: string, body: string): Promise<Message>
  searchJobs(user: ConnectedUser, filters: JobFilters): Promise<Page<Job>>
  listContracts(user: ConnectedUser, opts): Promise<Contract[]>
  listMilestones(user: ConnectedUser, contractId: string): Promise<Milestone[]>
  submitMilestone(user: ConnectedUser, input: MilestoneSubmission): Promise<void>
}
```

`McpTransport` ships first (JSON-RPC `tools/call`, strip `<untrusted_participant_content>`
wrappers, two-step `draft` → `confirm_draft` on writes, paginate around the 10-per-page job
cap). `GraphQLTransport` lands when the API key is approved. Swapping is a one-line change in
the container, and both can run side by side behind a per-user feature flag during cutover.

---

## The auth model (the part that must not be got wrong)

```
Portal user (Supabase Auth)  ──1:1──  Upwork account (OAuth token)  ──N:1──  Agency org
```

1. Bidder logs into the portal with their work email (Supabase Auth).
2. First run: "Connect your Upwork account" → Upwork OAuth consent → callback stores
   `access_token` + `refresh_token` **encrypted** against that portal user.
3. Every Upwork call is made with **that user's** token and the agency `org_uid`.
4. Upwork's own permission model (`user permission … relative to team, company`) enforces what
   each member may see. You inherit their RBAC for free rather than reimplementing it.

Consequence: bidders never open upwork.com after the one-time consent. That was the goal, and
this reaches it without account sharing.

**Token storage:** Postgres `pgcrypto` (or Supabase Vault) with a key held in the worker's env,
never in the Next.js bundle. Access tokens don't expire once created, but refresh tokens must
be exercised at least every two weeks — a weekly refresh job keeps every seat warm.

---

## Data model (first cut)

Two clearly separated zones — this is what keeps you inside the 24-hour cache rule.

### Zone 1 — Upwork mirror (revalidating cache, TTL ≤ 24h)
```
up_rooms          room_id, org_uid, topic, room_name, num_users, num_unread,
                  latest_story_id, latest_story_at, fetched_at
up_messages       story_id, room_id, author, body, sent_at, attachments jsonb, fetched_at
up_jobs           job_id, ciphertext, title, budget, job_type, client_* , published_at, fetched_at
up_contracts      contract_id, title, client, status, type, fetched_at
up_milestones     milestone_id, contract_id, state, deposit, funded, paid,
                  submission_count, due_at, fetched_at
```
Every table carries `fetched_at`. A nightly job hard-deletes or force-revalidates anything
older than 24h. Nothing is served to the UI past its TTL without a refetch.

### Zone 2 — Your own data (yours forever, no TTL)
```
users             portal identity, role (owner | manager | bidder), upwork_user_id
upwork_tokens     user_id, access_token(enc), refresh_token(enc), org_uid, refreshed_at
assignments       room_id | job_id → assigned_user_id, assigned_by, assigned_at
internal_notes    room_id, author_id, body            -- never leaves the portal
job_scores        job_id, score, reasoning, model, scored_at
proposal_drafts   job_id, author_id, cover_letter, bid, status, submitted_at
activity_log      actor_id, action, target, payload, at   -- full audit trail
sync_budget       day, endpoint, request_count          -- your own rate-limit ledger
```

---

## Sync strategy (the rate-limit-aware core)

One worker loop, one budget ledger, per-user tokens.

```
every 60s, for each connected user:
  1. get_rooms(org_uid, limit=100, sort=DESC)         → 1 request
  2. diff each room's latest_story_id vs up_rooms
  3. for CHANGED rooms only: get_room_messages(room_id) → 1 request each
  4. upsert, stamp fetched_at, push SSE event to that user's connected clients
```

Why this shape:
- The room list already carries `latestStory` and `numUnread`, so **one call detects all new
  activity across every conversation**. Never poll rooms individually to discover change.
- Steady state on a quiet minute: **11 requests/minute total** ≈ 15.8k/day, ~40% of the daily
  cap, leaving comfortable headroom for job searches, contracts, and milestone reads.
- Adaptive backoff: rooms with no activity for 7+ days drop to a 10-minute cadence.

Guardrails to build on day one, not day thirty:
- **Central token-bucket limiter** at 8 req/s (80% of the 10/s ceiling) across all users.
- **Daily counter** in `sync_budget`; hard-stop non-essential polling at 35k and alert.
- **429 handling:** exponential backoff with jitter, and pause that user's loop, never the
  whole fleet.
- **GraphQL errors return HTTP 200** — the client must inspect `errors[]` and
  `extensions.type` on every response, or failures will silently look like empty results.

---

## The three modules

### A. Job Finder
Server-side saved searches per bidder (skills, budget floor, client-hire-count, verified
payment only, `proposals_max` for low-competition jobs). Worker runs each on a schedule,
dedupes against `up_jobs`, scores new hits with Opus 5 against the agency's win history, and
surfaces a ranked queue. Manager assigns → bidder drafts → submit via the proposals API.

Two API facts to design around, both from the research doc:
- **No server-side date filter.** Sort by recency, filter on `publishedDateTime` locally.
- **Proposal counts are absent from search results.** Fetch a single-job `get` before showing
  competition numbers, or show nothing rather than something wrong.

### B. Unified Inbox (the WhatsApp-style piece)
Three-pane layout: room list (unread badges, assignee avatar, client name, topic) → thread →
composer + context sidebar (linked job/contract/milestone, client history, internal notes).

Portal-only features that upwork.com does not give you, and the real reason to build this:
- **Assignment** — every room has an owner; nothing sits unanswered because "someone else has it".
- **Internal notes** — a private layer per thread, invisible to the client.
- **SLA timers** — flag any client message unanswered for >N hours.
- **AI reply drafts** — Opus 5 drafts, human edits, human sends. Never auto-send.

Hard constraints to encode in the UI:
- Messages max **10,240 characters** — validate in the composer, don't truncate on send.
- On proposal rooms a freelancer **cannot send first**. If no room exists, show "waiting on
  client" rather than a dead composer.
- Attachments are a two-step upload (`start_attachment_upload` → confirm → send with
  `file_id` + `file_name`).

### C. Milestones & Payments
Per-contract milestone board grouped by state (`NotFunded` → `Active` → `Submitted` → `Paid`),
with funded/paid amounts and deliverable links. Actions: submit for review (message + optional
partial amount + deliverable attachments).

Highest-value view here is the one Upwork does not offer: **money at risk** — active
milestones that are *not funded*, and submitted milestones aging past N days without client
action. That single screen usually pays for the build.

---

## Build order

| Phase | Deliverable | Gate |
|---|---|---|
| **0** | Register the OAuth client via DCR + file the API key application in parallel | **neither blocks** — DCR is instant |
| **1** | Next.js + Supabase skeleton, portal auth, roles, schema, encrypted token vault | none |
| **2** | Per-user Upwork OAuth connect flow (auth code + PKCE) + `McpTransport` behind the interface | none |
| **3** | Sync worker + budget ledger + SSE — read-only inbox first | none |
| **4** | Inbox writes: reply, assign, internal notes, SLA timers | none |
| **5** | Job finder + AI scoring + proposal drafting/submission | none |
| **6** | Milestones board + money-at-risk view | none |
| **7** | `GraphQLTransport` + per-user cutover flag | needs approved key |

**Nothing is blocked.** Dynamic client registration removes the week-long API key wait from the
critical path entirely — the key application runs in the background and only matters at Phase 7,
where it upgrades the transport rather than unlocking the build.

---

## Risks

| Risk | Mitigation |
|---|---|
| API key rejected | Not blocking — the MCP transport carries the portal regardless. Apply from the account with the strongest history; re-apply is allowed after fixing gaps. |
| MCP surface changes without notice | Everything sits behind `UpworkTransport`; contract tests against recorded fixtures catch drift on every sync run |
| Key is non-transferable | Request from the **agency owner** account, never a staff member's |
| Ban risk from over-automation | Human-in-the-loop on every write. No auto-apply, no auto-send, no scraping. Rate-limit below the ceiling. |
| No sandbox exists | Fixture-driven local dev; a read-only "safe mode" flag that blocks all mutations in non-prod |
| 24h cache rule | `fetched_at` on every mirrored row + a nightly expiry job |
| Commercial use barred | Keep it single-tenant. Do not build agency-billing or resale features. |
| **Brand name in the hostname** | NEVER put "upwork" in a hostname. `upwork.your-agency.com` was flagged by Google Safe Browsing as phishing within hours — a known brand on an unrelated domain in front of a login form is the classic signature. Upwork's API terms forbid using their name anyway. Use a neutral name (`bidops.…`). |

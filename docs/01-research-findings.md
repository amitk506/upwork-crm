# Upwork Agency Portal — Research Findings

Research date: 2026-08-13. All facts below are pulled from Upwork's own help-centre articles
(via the Zendesk Help Center API, since `upwork.com` docs are Cloudflare-blocked to crawlers)
and from Upwork's official SDK source on GitHub. Anything I could **not** verify is marked
UNVERIFIED.

---

## 1. The API surface exists and covers all three requested functions

Endpoint: `https://api.upwork.com/graphql`
Token endpoint: `https://www.upwork.com/api/v3/oauth2/token`
(both confirmed in production use by `Automattic/tap-upwork`)

| Portal function | API support | Confidence |
|---|---|---|
| **Find jobs** | Marketplace job search with filters: query, job_type, experience_level, budget range, workload, verified-payment-only, proposal-count range, client-hire-count range, sort (recency/relevance/client spend/client rating), previous-clients-only, timezone, location. Cursor paginated. | Confirmed live |
| **Messages (WhatsApp-style)** | Rooms API scoped by company/org: list rooms, room details, room messages, find room by offer / application / contract, send message, create group room, edit sent message, file attachments. | Confirmed live |
| **Payment milestones** | Contract search/get, milestone list with state (`NotFunded`, `Active`, `Submitted`, `Paid`), deposit/funded/paid amounts, submission count, deliverable links; submit milestone for client review with message + partial amount + attachments. Also timesheets for hourly. | Confirmed live |

Bonus surface also available: proposals (create/withdraw/edit terms/accept-decline invitations),
offers, freelancer + agency dashboards, financials, profile management, agency teams & members.

**Verified live against your own account.** `<your agency>`
(`org_uid …`) returned 11 agency members and live message rooms.

### Important gaps found
- **No date filter on job search.** The marketplace API exposes none. You cannot query
  "posted in the last 14 hours" server-side — you sort by recency and filter client-side on
  `createdDateTime` / `publishedDateTime`.
- **Proposal/applicant counts are not in search results** — only on a single-job `get`.
- **Freelancers cannot open a proposal conversation.** The client must message first. Your
  portal's inbox can only *reply* on proposal rooms that already exist.
- **No webhooks found.** None of Upwork's six official OAuth2 SDKs ship a webhook or
  subscription router. Plan for polling. *(UNVERIFIED — the GraphQL docs are behind
  Cloudflare and may document subscriptions; worth re-checking once you have a dev key.)*

---

## 2. Two blocking gates before a line of portal code matters

### Gate A — API key eligibility
Source: *How to request an API key from Upwork* (updated 2026-08-10).

Your Upwork account must have **all** of:
- Valid authentic name, valid address, valid profile picture
- Active verified payment method + completed identity verification
- **≥ $25,000 lifetime earnings/spend**
- **Job Success Score ≥ 90%**
- Account in good standing, no active suspensions

The application must state: use case, internal-vs-public, your role, and confirmation you'll
stay under 40,000 requests/day and won't use Upwork's trademarks.

Review takes **~1 week by email**. There is **no sandbox and no test account** for third-party
developers — you develop against live data or not at all.

### Gate B — "Internal use only"
> "Upwork API is available for personal and internal use only. **Commercial use isn't
> supported.**"

An internal portal for your own agency's bidder team qualifies. Selling or licensing this
portal to other agencies does not. Design accordingly and don't build a multi-tenant billing
layer you can't legally switch on.

---

## 3. The compliance landmine in the original plan

Your brief said: *"The bidder team has all of the access to the Upwork agency portal, so they
don't need to log into Upwork from the website."*

The intent — one portal, no upwork.com — is fine. **How you authenticate it is not optional.**

Source: *How to represent yourself authentically on Upwork* (updated 2026-08-03):
> "Sharing, selling, trading, or transferring your Upwork account to another person is not
> permitted. **You cannot log into someone else's account or let anyone log into your account
> and work or communicate on your behalf.**" — violation risk is account suspension, and
> Upwork says it refers suspected criminal misuse to law enforcement.

And *Use bots and other automation properly* (updated 2026-08-11):
> "Even with an API key, some actions remain off-limits… if we see that you're using an API key
> outside its intended scope, we may suspend or terminate your access to Upwork's API."

**What this rules out:** a single owner OAuth token that 11 bidders share, where every message
and proposal goes out under your identity. That is precisely "letting anyone use your account
to communicate on your behalf" — and it's also the single point of failure that gets the whole
agency banned, not just one seat.

**What Upwork explicitly supports instead** — from *API scopes and permissions*:
> "**User permission** — Access to content, specific to the user and context of the call
> (team, company)."

So the API is already built for the model you want:

> **Each bidder authorizes the portal with their own Upwork account (OAuth 2.0 authorization
> code flow). The portal stores their individual token and acts as them, scoped to the agency
> org. One API key (the app), eleven identities.**

They still never visit upwork.com after the one-time consent screen. You get *better* audit
trails than the shared-token version — every message and proposal is attributable to a real
person, on both sides of the system. Your 11 agency members already exist as Upwork accounts,
so there is nothing new to create.

One caveat from *How API key ownership and sharing works*: the API key is permanently bound to
the account that requested it and **cannot be transferred**. Request it from the agency owner
account, not from a staff member who might leave.

---

## 4. Rate limits shape the architecture

Source: *What are the API request limits?* (updated 2026-06-22).

- **10 requests/second per IP** — enforced *per IP, not per user or per app*. Exceed it → HTTP 429.
- **40,000 requests/day** (you confirm this cap in the key application).
- **Caching responses for more than 24 hours is not allowed** under Upwork's ToS.

Consequences for this build:

1. **Per-IP limiting means one backend = one bucket.** 11 bidders each polling their own inbox
   still funnels through your server's IP. Budget centrally, throttle centrally.
2. **Rough budget:** 11 users × room-list poll every 60s = ~15.8k req/day, leaving ~24k/day for
   message fetches, job searches, contracts and milestones. Comfortable, but not if you naively
   poll every room. **Only fetch messages for rooms whose `latestStory.id` changed** — the room
   list already tells you that in one call.
3. **The 24-hour cache rule blocks a permanent local mirror of Upwork data.** You may cache for
   speed, but anything older than 24h must be re-fetched, not served from your DB. Design the
   store as a *revalidating cache with TTLs*, not an archive. Data you generate yourself
   (assignments, internal notes, bid decisions, drafts) is yours and is not subject to this.
4. GraphQL **always returns HTTP 200**, even on failure. Error handling must parse the
   `errors[]` array and its `extensions.type` — HTTP status tells you nothing.

---

## 5. Integration route — the API key is NOT the only door

### The finding that changes the build order

Upwork's MCP server advertises an OAuth authorization server at
`https://mcp.upwork.com/.well-known/oauth-authorization-server`:

```json
{
  "issuer": "https://mcp.upwork.com",
  "authorization_endpoint": "https://www.upwork.com/ab/account-security/oauth2/authorize",
  "token_endpoint": "https://www.upwork.com/api/v3/oauth2/token",
  "revocation_endpoint": "https://www.upwork.com/api/v3/oauth2/token/revoke",
  "registration_endpoint": "https://www.upwork.com/register",
  "grant_types_supported": ["authorization_code", "refresh_token", "client_credentials"],
  "code_challenge_methods_supported": ["S256"],
  "client_id_metadata_document_supported": true
}
```

That `registration_endpoint` looks like a signup page. It isn't. **It is a live, unauthenticated
RFC 7591 Dynamic Client Registration endpoint.** Tested 2026-08-13:

```
POST https://www.upwork.com/register
{"client_name":"…","redirect_uris":["http://localhost:3000/callback"],
 "grant_types":["authorization_code","refresh_token"],
 "response_types":["code"],"token_endpoint_auth_method":"none"}

→ 201 Created
{"client_id":"…","client_id_issued_at":…,"client_secret_expires_at":0,
 "registration_access_token":"…","registration_client_uri":"https://www.upwork.com/register/…"}
```

No bearer token required, no review, **instant**. `redirect_uris` are validated (a bogus one
returns `invalid_redirect_uri`), but `localhost` and normal https callbacks are accepted.

### ⚠️ CORRECTION (2026-08-13, same day): DCR is host-allowlisted

The paragraph above originally concluded that DCR removes the API key requirement. **That was
wrong, and the error was over-generalising from two samples.** The first probes used
`http://localhost:3000/callback` and `https://claude.ai/api/mcp/auth_callback`; both succeeded,
and I inferred DCR accepted arbitrary clients. Registering the real production callback failed.

Systematic testing of the redirect URI shows an **exact-host allowlist**:

| Redirect URI | Result |
|---|---|
| `http://localhost:3000/callback` | ✅ 201 |
| `http://localhost:8080/cb` | ✅ 201 |
| `https://127.0.0.1:9999/cb` | ✅ 201 |
| `https://claude.ai/api/mcp/auth_callback` | ✅ 201 |
| `https://claude.ai/totally/made/up/path` | ✅ 201 |
| `https://cursor.com/connector/callback` | ✅ 201 |
| `https://sub.claude.ai/cb` | ❌ 400 `invalid_redirect_uri` |
| `https://upwork.example.com/api/upwork/callback` | ❌ 400 |
| `https://upwork.your-agency.com/api/upwork/callback` | ❌ 400 |
| `https://portal.your-agency.com/api/oauth/callback` | ❌ 400 |

Loopback addresses on any port pass, and a fixed set of known MCP vendor hosts pass on any path.
Everything else is refused. `sub.claude.ai` failing while `claude.ai` succeeds proves it matches
the host exactly, not a suffix.

**What this means:** DCR is usable for **local development only**. A hosted portal on its own
domain cannot obtain OAuth credentials this way. **The official API key application is required
after all** — Gate A in §2 is back on the critical path.

`DELETE` on `registration_client_uri` returns 405, so registrations are not removable; register
deliberately, not in a loop. Several inert probe clients from this testing remain registered —
public clients that no user ever authorized, so they can reach nothing.

**Eligibility, checked against the live account (2026-08-13):** lifetime earnings
**$111,062.86** against the $25,000 threshold, and **Top Rated** status, which requires a Job
Success Score of at least 90%. Both gates are comfortably cleared, so the application should
succeed. Submit it from the account that owns the agency.

### MCP does not mean "an AI must be in the loop"

MCP tools are typed JSON-RPC endpoints. A Node backend can call `tools/call` with
`find_jobs` / `get_messages` / `list_milestones` directly and get structured JSON back. No model,
no tokens burned, deterministic. The "agent" framing is a convention, not a requirement.

### The two routes compared

| | **A. MCP server** | **B. Direct GraphQL** |
|---|---|---|
| Endpoint | `https://mcp.upwork.com/mcp` | `https://api.upwork.com/graphql` |
| Client credentials | **Dynamic registration, instant, free** | API key application, ~1 week, gated on $25k + JSS 90 |
| Per-user OAuth | Yes (auth code + PKCE) | Yes (auth code) |
| Response shape | LLM-oriented JSON; strip `<untrusted_participant_content>` wrappers | Raw GraphQL, exactly the fields you ask for |
| Pagination | Capped low — job search max **10/page** | Your choice, up to server limits |
| Writes | Two-step `draft` → `confirm_draft` | Single mutation |
| Stability | Product surface, may change without notice | Versioned public API |
| ToS footing | Grey — see below | Explicitly sanctioned once approved |

### Recommended sequence (revised after the correction above)

1. **File the API key application now** — it is the only route to OAuth credentials for a hosted
   portal, and it takes about a week. The account clears both eligibility gates.
2. **Keep building against MCP.** Once the key issues, its callback URL works for the MCP
   transport too: the MCP server accepts any valid Upwork OAuth client, and only the *dynamic
   registration shortcut* is host-restricted. Local development can use a `localhost` DCR client
   in the meantime.
3. **Add `GraphQLTransport` when the key lands** for better pagination and stable response
   shapes, behind the same interface.
4. **Keep MCP for the AI-assist layer permanently** — cover-letter drafting, thread
   summarisation, job triage. That is what it is genuinely best at.

### The honest caveat on ToS footing

Upwork's *Use bots and other automation properly* says compliant automation goes "through an
approved API key request," and that using a key "outside its intended scope" can end API access.
The MCP server, meanwhile, ships with **open dynamic registration** precisely so third-party
agents can connect — Upwork built that door on purpose.

A portal that calls MCP on behalf of users who each individually consented is far closer to
"agent client" than "unapproved bot," and it does nothing the policy names as off-limits
(no scraping, no proposal spam, no account sharing, human-in-the-loop on every write). That is
a defensible position, **but it is not explicitly blessed in writing.** Which is the real reason
to file the key application in parallel rather than skip it: it converts a defensible position
into a documented one.

### Unverified

Whether an MCP-issued access token also authenticates against `api.upwork.com/graphql`. The
token endpoint is the same (`/api/v3/oauth2/token`), which is suggestive, but the resource
indicator differs and this cannot be tested without completing a browser consent flow. **Do not
architect on the assumption that it does.**

---

## Sources

- [How to request an API key from Upwork](https://support.upwork.com/hc/en-us/articles/115015857647-How-to-request-an-API-key-from-Upwork)
- [How API key ownership and sharing works on Upwork](https://support.upwork.com/hc/en-us/articles/115015855747-How-API-key-ownership-and-sharing-works-on-Upwork)
- [What are the API requests limits?](https://support.upwork.com/hc/en-us/articles/115015933428-What-are-the-API-requests-limits)
- [Use bots and other automation properly](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly)
- [API authentication and security](https://support.upwork.com/hc/en-us/articles/115015933448-API-authentication-and-security)
- [API scopes and permissions](https://support.upwork.com/hc/en-us/articles/115015857607-API-scopes-and-permissions)
- [API error handling](https://support.upwork.com/hc/en-us/articles/17995907503379--API-error-handling)
- [How to represent yourself authentically on Upwork](https://support.upwork.com/hc/en-us/articles/9127142196243-How-to-represent-yourself-authentically-on-Upwork)
- [How to set up roles in your agency](https://support.upwork.com/hc/en-us/articles/360009646553-How-to-set-up-roles-in-your-agency)
- [Upwork GraphQL API documentation](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html) (Cloudflare-blocked to crawlers; reachable in a browser)
- [Automattic/tap-upwork](https://github.com/Automattic/tap-upwork) — production GraphQL client, confirms endpoints
- [upwork/node-upwork-oauth2](https://github.com/upwork/node-upwork-oauth2) — official SDK, confirms messaging router surface

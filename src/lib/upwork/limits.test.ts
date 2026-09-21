import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isKnownTool,
  isWriteTool,
  qualifiedToolName,
  SELF_IMPOSED,
  TOOL_NAMESPACE,
  TOOL_POLICY,
  UPWORK_PUBLISHED,
  type ToolName,
} from './limits.ts'

/**
 * These guard the things that could get the agency's Upwork account
 * restricted. Run with: npm run test:limits
 */

test('self-imposed limits stay strictly under Upwork published limits', () => {
  assert.ok(
    SELF_IMPOSED.requestsPerSecond < UPWORK_PUBLISHED.requestsPerSecond,
    `req/s ${SELF_IMPOSED.requestsPerSecond} must be under ${UPWORK_PUBLISHED.requestsPerSecond}`,
  )
  assert.ok(
    SELF_IMPOSED.requestsPerDay < UPWORK_PUBLISHED.requestsPerDay,
    `req/day ${SELF_IMPOSED.requestsPerDay} must be under ${UPWORK_PUBLISHED.requestsPerDay}`,
  )
  assert.ok(
    SELF_IMPOSED.cacheMaxAgeHours < UPWORK_PUBLISHED.cacheMaxAgeHours,
    'cache TTL must be under the 24h ToS ceiling',
  )
})

test('background work is cut off well before the daily cap', () => {
  assert.ok(
    SELF_IMPOSED.backgroundCutoffPerDay < SELF_IMPOSED.requestsPerDay,
    'background sync must stop before interactive work loses its budget',
  )
})

test('burst capacity cannot exceed one second of Upwork allowance', () => {
  assert.ok(
    SELF_IMPOSED.burstCapacity <= UPWORK_PUBLISHED.requestsPerSecond,
    'a full bucket drained at once must not exceed the per-second ceiling',
  )
})

test('tool names are namespaced on the wire', () => {
  // Regression: calling the bare name returns
  // `400 invalid tool name list_accounts: invalid resource name`.
  // Verified against the live server: tools/list returns 31 tools, all prefixed.
  assert.equal(qualifiedToolName('list_accounts'), 'upwork__list_accounts')
  assert.equal(qualifiedToolName('get_messages'), 'upwork__get_messages')
  assert.equal(qualifiedToolName('send_message'), 'upwork__send_message')

  for (const name of Object.keys(TOOL_POLICY) as ToolName[]) {
    assert.ok(
      qualifiedToolName(name).startsWith(TOOL_NAMESPACE),
      `${name} must be namespaced before it goes on the wire`,
    )
    // The policy map itself must stay unprefixed, or the prefix gets applied twice.
    assert.ok(!name.startsWith(TOOL_NAMESPACE), `${name} should not be prefixed in TOOL_POLICY`)
  }
})

test('unknown tools are rejected', () => {
  assert.equal(isKnownTool('send_message'), true)
  assert.equal(isKnownTool('delete_everything'), false)
  assert.equal(isKnownTool(''), false)
  // guard against prototype keys being treated as allowlisted tools
  assert.equal(isKnownTool('constructor'), false)
  assert.equal(isKnownTool('toString'), false)
})

test('every mutating Upwork tool is marked as a write', () => {
  // If Upwork adds a tool and someone allowlists it as a read by mistake, this
  // is the test that should fail. Anything whose name implies mutation must be
  // flagged, so the write gate applies.
  const mutatingVerbs = ['send', 'submit', 'manage', 'confirm', 'create', 'update', 'delete', 'save']

  for (const name of Object.keys(TOOL_POLICY) as ToolName[]) {
    const looksMutating = mutatingVerbs.some((verb) => name.startsWith(verb))
    if (looksMutating) {
      assert.equal(isWriteTool(name), true, `${name} looks mutating but is not marked as a write`)
    }
  }
})

test('known write tools are all flagged', () => {
  for (const name of [
    'send_message',
    'start_attachment_upload',
    'store_uploaded_files',
    'confirm_attachment_upload',
  ] as ToolName[]) {
    assert.equal(isWriteTool(name), true, `${name} must be a write`)
  }
})

test('proposal and milestone tools are not in the policy at all', () => {
  // This copy of the portal is an inbox. A tool absent from the map cannot be
  // called — the request is refused before it is built — which is stricter
  // than listing it as a blocked write, and there is nothing here that should
  // ever know those tools exist.
  for (const name of ['manage_proposals', 'confirm_draft', 'submit_milestones', 'find_jobs']) {
    assert.equal(isKnownTool(name), false, `${name} should not be a known tool`)
  }
})

test('read tools used by the Phase 2 transport are allowlisted and non-writing', () => {
  for (const name of [
    'list_accounts',
    'get_messages',
    'list_contracts',
    'list_milestones',
  ] as ToolName[]) {
    assert.equal(isKnownTool(name), true, `${name} must be allowlisted`)
    assert.equal(isWriteTool(name), false, `${name} must not be a write`)
  }
})

test('the background sync fits inside its daily cutoff', () => {
  // Upwork has no webhooks, so new messages are polled for. One request per
  // profile per tick detects activity across every conversation, because the
  // room list carries each one's latest message id.
  const PROFILES = 8 // what the agency plans to run
  const INTERVAL_SECONDS = 60
  const ticksPerDay = (24 * 60 * 60) / INTERVAL_SECONDS

  const roomListCalls = PROFILES * ticksPerDay
  assert.ok(
    roomListCalls < SELF_IMPOSED.backgroundCutoffPerDay,
    `polling costs ${roomListCalls}/day, over the ${SELF_IMPOSED.backgroundCutoffPerDay} background cutoff`,
  )

  // Headroom must remain for the message fetches an active day triggers, on
  // top of anything people do interactively.
  const headroom = SELF_IMPOSED.backgroundCutoffPerDay - roomListCalls
  assert.ok(headroom > 5000, `only ${headroom} requests left for message fetches`)
})

test('a per-second burst across every profile stays under the limiter', () => {
  // Worst case: every profile's tick fires at once.
  const PROFILES = 8
  assert.ok(
    PROFILES <= UPWORK_PUBLISHED.requestsPerSecond,
    'a simultaneous tick across all profiles would exceed the per-second ceiling',
  )
})

test('gap-filling message fetches still fit under the background cutoff', () => {
  // The wait meter needs a reply state for every conversation, not only the ones
  // that changed today — so sync tops up a few rooms per tick. That top-up has
  // to live inside the same budget the polling already spends.
  const PROFILES = 8
  const ticksPerDay = (24 * 60 * 60) / 60

  const polling = PROFILES * ticksPerDay
  const hydration = SELF_IMPOSED.hydrateRoomsPerTick * ticksPerDay
  const worstCase = polling + hydration

  assert.ok(
    worstCase < SELF_IMPOSED.backgroundCutoffPerDay,
    `polling plus hydration costs ${worstCase}/day, over the ${SELF_IMPOSED.backgroundCutoffPerDay} cutoff`,
  )

  // And comfortably inside what Upwork actually publishes, which is the limit
  // that carries consequences.
  assert.ok(worstCase < UPWORK_PUBLISHED.requestsPerDay / 2)

  // A burst is bounded too: one tick can issue at most one room list plus the
  // hydration fetches per profile, and the limiter runs at 6/second.
  const perTickBurst = PROFILES + SELF_IMPOSED.hydrateRoomsPerTick
  assert.ok(
    perTickBurst / SELF_IMPOSED.requestsPerSecond < 60,
    'a single tick must finish well inside its own interval',
  )
})

test('paged room listing still fits the budget it belongs to', () => {
  const PROFILES = 8
  const ticksPerDay = (24 * 60 * 60) / 60

  // Background: polling plus hydration, every minute, unattended.
  const background =
    PROFILES * SELF_IMPOSED.roomPagesBackground * ticksPerDay +
    SELF_IMPOSED.hydrateRoomsPerTick * ticksPerDay

  assert.ok(
    background < SELF_IMPOSED.backgroundCutoffPerDay,
    `unattended sync costs ${background}/day, over the ${SELF_IMPOSED.backgroundCutoffPerDay} cutoff`,
  )

  // A second background page would blow it, which is why the constant is 1.
  const withTwoPages = PROFILES * 2 * ticksPerDay + SELF_IMPOSED.hydrateRoomsPerTick * ticksPerDay
  assert.ok(
    withTwoPages > SELF_IMPOSED.backgroundCutoffPerDay,
    'if two background pages now fit, revisit roomPagesBackground rather than leaving it at 1',
  )

  // Interactive: one click, bounded, and quick enough not to feel hung.
  const perClick = PROFILES * SELF_IMPOSED.roomPagesInteractive
  assert.ok(perClick <= 40, `a refresh costs ${perClick} requests`)
  assert.ok(
    perClick / SELF_IMPOSED.requestsPerSecond < 10,
    'a manual refresh must finish in a few seconds',
  )
  assert.ok(SELF_IMPOSED.roomPagesInteractive > SELF_IMPOSED.roomPagesBackground)
})

test('refreshing proposals hourly is a rounding error against the budget', () => {
  const PROFILES = 8
  const ticksPerDay = (24 * 60 * 60) / 60
  const proposalCallsPerDay = PROFILES * (24 * 60) / SELF_IMPOSED.proposalRefreshMinutes

  const background =
    PROFILES * SELF_IMPOSED.roomPagesBackground * ticksPerDay +
    SELF_IMPOSED.hydrateRoomsPerTick * ticksPerDay +
    proposalCallsPerDay

  assert.ok(
    background < SELF_IMPOSED.backgroundCutoffPerDay,
    `unattended sync costs ${background}/day, over the ${SELF_IMPOSED.backgroundCutoffPerDay} cutoff`,
  )

  // The whole point of the hourly gate: per-tick would not fit.
  const perTick = PROFILES * ticksPerDay
  assert.ok(
    PROFILES * SELF_IMPOSED.roomPagesBackground * ticksPerDay +
      SELF_IMPOSED.hydrateRoomsPerTick * ticksPerDay +
      perTick >
      SELF_IMPOSED.backgroundCutoffPerDay,
    'if fetching proposals every tick now fits, revisit proposalRefreshMinutes deliberately',
  )
  assert.ok(proposalCallsPerDay < 250, `${proposalCallsPerDay}/day is more than intended`)
})

test('the attachment upload chain is allowlisted and gated as writes', () => {
  // Uploading puts client file content into Upwork storage and attaches it to a
  // real conversation. Each step must be a known tool (or callTool refuses it)
  // and must be governed by UPWORK_ALLOWED_WRITES rather than always-on.
  for (const name of [
    'start_attachment_upload',
    'store_uploaded_files',
    'confirm_attachment_upload',
  ] as ToolName[]) {
    assert.equal(isKnownTool(name), true, `${name} must be allowlisted`)
    assert.equal(isWriteTool(name), true, `${name} must be gated as a write`)
  }

  // Reading back the upload's status changes nothing.
  assert.equal(isKnownTool('get_upload_status' as ToolName), true)
  assert.equal(isWriteTool('get_upload_status' as ToolName), false)
})

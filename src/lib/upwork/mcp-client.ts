import 'server-only'

import { serverEnv } from '@/lib/env'
import { logActivity } from '@/lib/activity'
import {
  allowedWriteTools,
  isKnownTool,
  isWriteAllowed,
  qualifiedToolName,
  SELF_IMPOSED,
  TOOL_POLICY,
  type ToolName,
} from './limits'
import { withRateLimit } from './rate-limiter'
import { recordProfileOutcome } from './profiles'
import { UpworkApiError, UpworkPolicyError, type ConnectedUser } from './types'

/**
 * JSON-RPC client for Upwork's MCP server.
 *
 * MCP tools are plain typed RPC endpoints — no model sits in this path. The
 * "agent" framing is a convention of the protocol, not a requirement of it.
 *
 * Safety, in the order the gates fire:
 *   1. tool must be on the allowlist in limits.ts     → else refused locally
 *   2. write tools require UPWORK_ALLOW_WRITES=true   → else refused locally
 *   3. daily budget + token bucket                    → else refused or delayed
 *   4. bounded retries with jittered backoff          → never a tight loop
 *   5. per-user circuit breaker on repeated failures  → we stop knocking
 * Gates 1–3 all run BEFORE any network request exists.
 */

const MCP_ENDPOINT = 'https://mcp.upwork.com/mcp'
const PROTOCOL_VERSION = '2025-06-18'

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type ToolResult = {
  content?: { type: string; text?: string }[]
  structuredContent?: unknown
  isError?: boolean
}

let requestId = 0

/** Any write capability at all? Used only for display. */
export function writesEnabled(): boolean {
  return allowedWriteTools().size > 0
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * MCP's streamable HTTP transport may answer with either JSON or an SSE stream.
 * Both carry the same JSON-RPC envelope.
 */
async function parseResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const parsed = JSON.parse(payload) as JsonRpcResponse
        if (parsed.result !== undefined || parsed.error !== undefined) return parsed
      } catch {
        // keep scanning; a stream can carry notifications we do not need
      }
    }
    throw new UpworkApiError('MCP stream contained no JSON-RPC result', null, false)
  }

  return (await response.json()) as JsonRpcResponse
}

/**
 * MCP sessions.
 *
 * Streamable HTTP is NOT stateless: the client must send `initialize` before
 * any other request, and echo back the `Mcp-Session-Id` the server assigns.
 * Calling tools/call cold returns 400. Sessions are cached per user and
 * re-established automatically when the server forgets one.
 */
const sessions = new Map<string, { id: string | null; at: number }>()
const SESSION_TTL_MS = 20 * 60_000

/** One raw POST. Returns the parsed envelope plus any session id. */
async function post(
  user: ConnectedUser,
  body: Record<string, unknown>,
  sessionId: string | null,
): Promise<{ parsed: JsonRpcResponse | null; sessionId: string | null }> {
  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${user.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })

  const returnedSession = response.headers.get('mcp-session-id') ?? sessionId

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after')) || null
    throw new UpworkApiError(
      `Upwork returned 429 Too Many Requests${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`,
      429,
      true,
    )
  }

  if (!response.ok) {
    // Include the body. The previous version reported only the status, which
    // made a 400 impossible to diagnose without reproducing it by hand.
    const detail = (await response.text().catch(() => '')).slice(0, 400)
    throw new UpworkApiError(
      `Upwork MCP returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
      response.status >= 500,
    )
  }

  // Notifications get 202 with no body.
  if (response.status === 202) return { parsed: null, sessionId: returnedSession }

  return { parsed: await parseResponse(response), sessionId: returnedSession }
}

/** Performs the initialize handshake and caches the resulting session. */
async function openSession(user: ConnectedUser): Promise<string | null> {
  const { parsed, sessionId } = await post(
    user,
    {
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agency-portal', version: '1.0.0' },
      },
    },
    null,
  )

  if (parsed?.error) {
    throw new UpworkApiError(
      `MCP initialize failed ${parsed.error.code}: ${parsed.error.message}`,
      null,
      false,
    )
  }

  // The spec requires this acknowledgement before normal requests.
  await post(
    user,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    sessionId,
  ).catch(() => undefined)

  sessions.set(user.userId, { id: sessionId, at: Date.now() })
  return sessionId
}

async function currentSession(user: ConnectedUser): Promise<string | null> {
  const cached = sessions.get(user.userId)
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.id
  return openSession(user)
}

async function rpc(
  user: ConnectedUser,
  method: string,
  params: Record<string, unknown>,
  endpointLabel: string,
  priority: 'interactive' | 'background',
): Promise<unknown> {
  let lastError: unknown
  let reinitialised = false

  for (let attempt = 0; attempt <= SELF_IMPOSED.maxRetries; attempt++) {
    try {
      return await withRateLimit(endpointLabel, priority, async () => {
        const sessionId = await currentSession(user)

        const { parsed } = await post(
          user,
          { jsonrpc: '2.0', id: ++requestId, method, params },
          sessionId,
        )

        if (parsed?.error) {
          throw new UpworkApiError(
            `MCP error ${parsed.error.code}: ${parsed.error.message}`,
            null,
            false,
          )
        }

        return parsed?.result
      })
    } catch (err) {
      lastError = err

      // A local policy refusal is final — retrying cannot change the answer,
      // and retrying a budget refusal is exactly the runaway pattern we avoid.
      if (err instanceof UpworkPolicyError) throw err

      // A dropped session shows up as 400/404. Re-handshake once, then retry.
      const sessionLost =
        err instanceof UpworkApiError && (err.status === 400 || err.status === 404)

      if (sessionLost && !reinitialised) {
        reinitialised = true
        sessions.delete(user.userId)
        continue
      }

      if (err instanceof UpworkApiError && err.status === 401) {
        throw err // token problem; retrying cannot help
      }

      const retryable = err instanceof UpworkApiError && err.retryable
      if (!retryable || attempt === SELF_IMPOSED.maxRetries) break

      // Exponential backoff with jitter: 1s, 2s, 4s ± up to 500ms.
      const delay = 1000 * 2 ** attempt + Math.floor(Math.random() * 500)
      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * Call an Upwork MCP tool.
 *
 * `user.userId` carries the PROFILE id: rate limiting and the circuit breaker
 * are per Upwork identity, because that is what Upwork actually throttles.
 * org_uid is filled from the profile so a caller cannot address another org.
 */
/**
 * Call a tool whose arguments are flat rather than the usual envelope.
 *
 * Almost every Upwork tool takes { action, org_uid, params }. store_uploaded_files
 * does not — it takes { task_id, org_uid, files } at the top level. Rather than
 * bend callTool's shape for one exception, this shares its gates and differs only
 * in how the arguments are assembled.
 */
export async function callToolRaw<T = unknown>(
  user: ConnectedUser,
  tool: string,
  args: Record<string, unknown>,
  opts: { priority?: 'interactive' | 'background' } = {},
): Promise<T> {
  return callToolInner<T>(user, tool, tool, { org_uid: user.orgUid, ...args }, opts)
}

export async function callTool<T = unknown>(
  user: ConnectedUser,
  tool: string,
  action: string,
  params: Record<string, unknown> = {},
  opts: { priority?: 'interactive' | 'background' } = {},
): Promise<T> {
  return callToolInner<T>(user, tool, action, { action, org_uid: user.orgUid, params }, opts)
}

/**
 * What is safe to keep in the audit trail.
 *
 * An upload's arguments contain the file's base64 bytes. Writing those into
 * activity_log would put a copy of every attachment in the database — bloating
 * it, and quietly retaining client file content the portal has no business
 * storing. Only the shape is recorded.
 */
function auditable(args: Record<string, unknown>): Record<string, unknown> {
  const files = args.files
  if (!Array.isArray(files)) return args

  return {
    ...args,
    files: files.map((f) => {
      const file = (f ?? {}) as Record<string, unknown>
      return { name: file.name, type: file.type, size: file.size }
    }),
  }
}

async function callToolInner<T = unknown>(
  user: ConnectedUser,
  tool: string,
  action: string,
  args: Record<string, unknown>,
  opts: { priority?: 'interactive' | 'background' } = {},
): Promise<T> {
  // --- gate 1: allowlist --------------------------------------------------
  if (!isKnownTool(tool)) {
    throw new UpworkPolicyError(
      `"${tool}" is not on this portal's allowlist of Upwork tools, so it will not be called. ` +
        `Add it to TOOL_POLICY in src/lib/upwork/limits.ts if it genuinely belongs.`,
      'unknown_tool',
    )
  }
  const toolName: ToolName = tool

  // --- gate 2: per-tool write guard ---------------------------------------
  if (!isWriteAllowed(toolName)) {
    throw new UpworkPolicyError(
      `"${tool}" changes data on Upwork and is not in UPWORK_ALLOWED_WRITES. ` +
        `Enable it only alongside a human confirmation step — never on a timer or a retry.`,
      'writes_disabled',
    )
  }

  const priority = opts.priority ?? 'interactive'
  const label = `${tool}.${action}`

  try {
    const result = (await rpc(
      user,
      'tools/call',
      {
        // Namespaced on the wire — the bare name is rejected as an invalid
        // resource name. See TOOL_NAMESPACE.
        name: qualifiedToolName(toolName),
        arguments: args,
      },
      label,
      priority,
    )) as ToolResult

    await recordProfileOutcome(user.userId, true)

    if (result?.isError) {
      const text = result.content?.map((c) => c.text ?? '').join('\n') ?? 'unknown tool error'
      throw new UpworkApiError(`Upwork tool ${label} failed: ${text}`, null, false)
    }

    // Only audit writes and failures — logging every read would bury the trail
    // that matters in noise.
    if (TOOL_POLICY[toolName].write) {
      await logActivity({
        actorId: user.userId,
        action: `upwork.${label}`,
        payload: { args: auditable(args) },
        succeeded: true,
      })
    }

    return extractPayload<T>(result)
  } catch (err) {
    const isPolicy = err instanceof UpworkPolicyError

    // A local refusal never counts as an Upwork failure — it never reached them.
    if (!isPolicy) await recordProfileOutcome(user.userId, false)

    await logActivity({
      actorId: user.userId,
      action: `upwork.${label}`,
      payload: { args: auditable(args), refusedLocally: isPolicy },
      succeeded: false,
      error: err instanceof Error ? err.message : String(err),
    })

    throw err
  }
}

/**
 * MCP tools return content blocks aimed at models. Prefer structuredContent
 * when present, otherwise parse the first JSON text block.
 */
function extractPayload<T>(result: ToolResult): T {
  if (result?.structuredContent !== undefined) return result.structuredContent as T

  const text = result?.content?.find((c) => c.type === 'text')?.text
  if (!text) return {} as T

  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

/**
 * Message bodies and room names arrive wrapped in <untrusted_participant_content>
 * markers — a prompt-injection guard for model consumers. We render this text in
 * a browser, so strip the markers; React escapes the rest.
 */
export function stripUntrustedMarkers(value: string | null | undefined): string | null {
  if (!value) return null
  return value
    .replace(/<\/?untrusted_participant_content>/g, '')
    .trim()
}

/** Surfaced on the ops screen so the current posture is never a guess. */
export function safetyPosture() {
  return {
    endpoint: MCP_ENDPOINT,
    protocolVersion: PROTOCOL_VERSION,
    writesEnabled: writesEnabled(),
    allowedTools: Object.entries(TOOL_POLICY)
      .filter(([, policy]) => !policy.write)
      .map(([name]) => name),
    blockedWriteTools: Object.entries(TOOL_POLICY)
      .filter(([, policy]) => policy.write)
      .map(([name]) => name),
    clientConfigured: Boolean(serverEnv().UPWORK_CLIENT_ID),
  }
}

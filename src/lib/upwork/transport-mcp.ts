import 'server-only'

import { callTool, callToolRaw } from './mcp-client'
import { listOf, toIso } from './payload'
import { cleanMessageText, isSystemEvent } from './text'
import {
  MESSAGE_MAX_LENGTH,
  type ConnectedUser,
  type Contract,
  type Message,
  type Milestone,
  type PendingUpload,
  type Proposal,
  type UploadedFile,
  UpworkApiError,
  type Room,
  type UpworkTransport,
  type CallPriority,
} from './types'

/**
 * MCP implementation of UpworkTransport — the read surface only.
 *
 * Response shapes vary by tool (some return a GraphQL-ish `data.<x>.edges[]`
 * envelope, others a flat array), and they are a product surface that can change
 * without notice. Every mapper here is defensive: unknown fields are ignored and
 * missing ones become null rather than throwing, so a shape change degrades a
 * field instead of taking down the page.
 */

type Unknown = Record<string, unknown>

const asRecord = (v: unknown): Unknown => (v && typeof v === 'object' ? (v as Unknown) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Unwraps `{ data: { <key>: { edges: [{ node }], pageInfo } } }` envelopes. */
function edges(payload: unknown, key: string): { nodes: Unknown[]; pageInfo: Unknown } {
  const root = asRecord(payload)
  const data = asRecord(root.data)
  const container = asRecord(data[key] ?? root[key])
  const nodes = arr(container.edges)
    .map((edge) => asRecord(asRecord(edge).node))
    .filter((node) => Object.keys(node).length > 0)
  return { nodes, pageInfo: asRecord(container.pageInfo) }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toRoom(node: Unknown, orgUid: string): Room {
  const latest = asRecord(node.latestStory)
  return {
    roomId: String(node.id ?? node.room_id ?? ''),
    orgUid,
    roomName: cleanMessageText(str(node.roomName)),
    topic: cleanMessageText(str(node.topic)),
    numUsers: num(node.numUsers),
    numUnread: num(node.numUnread) ?? 0,
    latestStoryId: str(latest.id),
    // `created` in the new shape, `createdDateTime` in the old; fall back to the
    // room's own lastActivity, which carries the same instant.
    latestStoryAt: toIso(latest.created ?? latest.createdDateTime ?? node.lastActivity),
    latestSnippet: cleanMessageText(str(latest.message)),
    createdAtUpwork: toIso(node.createdAtDateTime),
    lastVisitedAt: toIso(node.lastVisitedDateTime),
    // New, and worth keeping: this is the contract link the room never used to
    // expose — the missing join from a conversation to the work it is about.
    contractId: str(node.contractId),
    contractStatus: str(node.contractStatus),
  }
}

/**
 * Upwork returns NO sender on a message — verified against list_messages and
 * get_message, both of which yield only { actionVerb, createdDateTime, id,
 * message }. So authorId/authorName stay null and isOutbound stays false here;
 * authorship for our own replies is recovered from the sent_messages table,
 * which is the only place it is actually known.
 */
function toMessage(node: Unknown, roomId: string): Message {
  const actionVerb = str(node.actionVerb)
  return {
    storyId: String(node.id ?? ''),
    roomId,
    authorId: null,
    authorName: null,
    isOutbound: false,
    // Resolved during sync, where the room's name and last-visit time are known.
    direction: 'unknown',
    directionSource: null,
    actionVerb,
    isSystem: isSystemEvent(actionVerb),
    body: cleanMessageText(str(node.message)),
    attachments: arr(node.attachments),
    sentAt: str(node.createdDateTime),
    editedAt: str(node.updatedDateTime),
  }
}

function toContract(node: Unknown, orgUid: string): Contract {
  const contract = asRecord(node.contract ?? node)
  const client = asRecord(contract.client ?? contract.buyer)
  return {
    contractId: String(contract.id ?? ''),
    orgUid,
    title: str(contract.title),
    clientName: cleanMessageText(str(client.name ?? contract.clientName)),
    status: str(contract.status),
    contractType: str(contract.contractType ?? contract.type),
    hourlyRate: num(contract.hourlyRate ?? contract.rate),
    currency: str(contract.currency),
    startedAt: str(contract.startDateTime ?? contract.started_at),
    endedAt: str(contract.endDateTime ?? contract.ended_at),
  }
}

function toMilestone(node: Unknown, contractId: string): Milestone {
  const deposit = asRecord(node.depositAmount)
  const funded = asRecord(node.fundedAmount)
  const paid = asRecord(node.paid ?? node.paidAmount)

  return {
    milestoneId: String(node.id ?? ''),
    contractId,
    title: str(node.description ?? node.title),
    description: str(node.details ?? node.description),
    // state is free text on purpose — Upwork can add states without warning
    state: str(node.state) ?? 'Unknown',
    stateLabel: str(node.state_label ?? node.stateLabel),
    depositAmount: num(deposit.rawValue ?? deposit.amount ?? node.depositAmount),
    fundedAmount: num(funded.rawValue ?? funded.amount ?? node.fundedAmount),
    paidAmount: num(paid.rawValue ?? paid.amount ?? node.paid),
    currency: str(deposit.currency ?? funded.currency),
    submissionCount: num(node.submissionCount) ?? 0,
    dueAt: str(node.dueDateTime),
    submittedAt: str(node.submittedDateTime),
    deliverables: arr(node.submissions ?? node.deliverables),
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class McpTransport implements UpworkTransport {
  readonly name = 'mcp' as const

  async listAccounts(user: ConnectedUser) {
    const payload = await callTool<Unknown>(user, 'list_accounts', 'list')
    return arr(payload.accounts).map((a) => {
      const account = asRecord(a)
      return {
        name: str(account.name) ?? '',
        orgUid: String(account.org_uid ?? ''),
        role: str(account.role) ?? '',
      }
    })
  }

  async listRooms(
    user: ConnectedUser,
    opts: { limit?: number; cursor?: string; priority?: CallPriority } = {},
  ) {
    const payload = await callTool(user, 'get_messages', 'list_rooms', {
      // Rooms allow up to 100 per page; one call surfaces activity across every
      // conversation via latestStory, which is what keeps the sync budget small.
      limit: Math.min(opts.limit ?? 100, 100),
      sort_order: 'DESC',
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    }, { priority: opts.priority })

    const { nodes, endCursor, hasNextPage } = listOf(payload, 'roomList', 'rooms')
    return { items: nodes.map((n) => toRoom(n, user.orgUid)), endCursor, hasNextPage }
  }

  /**
   * Proposals we have sent, each naming the job posting it was for.
   *
   * Shape confirmed against a live response: the posting sits under
   * `marketplaceJobPosting`, with the title nested one level further under
   * `content`. Money arrives as { rawValue, currency } like everywhere else.
   */
  async listProposals(user: ConnectedUser, opts: { priority?: CallPriority } = {}) {
    const payload = await callTool(user, 'list_freelancer_proposals', 'list', {}, {
      priority: opts.priority,
    })

    const { nodes } = listOf(payload, 'vendorProposals', 'proposals')
    return nodes.map((node): Proposal => {
      const posting = asRecord(node.marketplaceJobPosting)
      const content = asRecord(posting.content)
      const status = asRecord(node.status)
      const rate = asRecord(asRecord(node.terms).chargeRate)
      const created = asRecord(asRecord(node.auditDetails).createdDateTime)

      return {
        proposalId: String(node.id ?? ''),
        jobId: str(posting.id),
        jobTitle: cleanMessageText(str(content.title)),
        status: str(status.status),
        statusLabel: str(status.status_label),
        rateAmount: num(rate.rawValue),
        rateCurrency: str(rate.currency),
        createdAt: str(created.displayValue),
      }
    })
  }

  /**
   * Put files into Upwork storage and hand back what a message needs to attach.
   *
   * Four steps, because Upwork's upload is a session rather than a POST:
   *
   *   1. start_attachment_upload  — opens a short-lived session, and returns the
   *      task id inside a sentence written for a human, not as a field. Hence the
   *      regex: it is the documented shape, unfortunately.
   *   2. store_uploaded_files     — the bytes. This is the tool an "MCP App host"
   *      calls after showing its own upload UI, which is exactly what the portal
   *      is doing: the composer IS the upload component. The alternative is
   *      sending people to Upwork's own page and asking them to come back.
   *   3. get_upload_status        — the file_uid values, once processing is done.
   *   4. confirm_attachment_upload — retains them; without it they expire.
   *
   * The session is per room and short-lived, so this runs at send time rather
   * than when a file is picked.
   */
  async uploadAttachments(
    user: ConnectedUser,
    roomId: string,
    files: PendingUpload[],
  ): Promise<UploadedFile[]> {
    if (files.length === 0) return []

    const started = await callTool(user, 'start_attachment_upload', 'upload', {
      context: 'messages',
      room_id: roomId,
      reason: 'Attached to a reply sent from the agency portal',
    }, { priority: 'interactive' })

    const asText = typeof started === 'string' ? started : JSON.stringify(started ?? '')
    const taskId =
      str(asRecord(started).task_id) ?? (asText.match(/task_id=([0-9a-f-]{36})/) ?? [])[1] ?? null

    if (!taskId) {
      throw new UpworkApiError(
        'Upwork did not open an upload session. The attachment was not sent.',
        null,
        true,
      )
    }

    // store_uploaded_files takes the whole batch; its arguments are flat rather
    // than nested under `params` like every other tool.
    await callToolRaw(user, 'store_uploaded_files', {
      task_id: taskId,
      files: files.map((f) => ({ name: f.name, type: f.type, size: f.size, data: f.base64 })),
    })

    const status = await callTool(user, 'get_upload_status', 'get', { task_id: taskId })
    const ready = arr(asRecord(status).files).map(asRecord)

    const uploaded = ready
      .filter((f) => str(f.status) === 'done' && str(f.file_uid))
      .map((f): UploadedFile => ({
        fileId: str(f.file_uid)!,
        fileName: str(f.name) ?? 'attachment',
        imageId: str(f.image_id),
        contentType: str(f.content_type),
        size: num(f.size),
      }))

    if (uploaded.length === 0) {
      throw new UpworkApiError('Upwork accepted the files but reported none ready.', null, true)
    }

    // Confirm now wants the same context as the session that produced the
    // files, plus the file ids themselves — it used to take the task id alone.
    // Verified against the live contract on 15 Sep 2026 after every send with
    // an attachment began failing with "context is required".
    await callTool(user, 'confirm_attachment_upload', 'confirm', {
      task_id: taskId,
      context: 'messages',
      room_id: roomId,
      file_ids: uploaded.map((f) => f.fileId),
    })

    return uploaded
  }

  async listMessages(
    user: ConnectedUser,
    roomId: string,
    opts: { limit?: number; priority?: CallPriority } = {},
  ) {
    const payload = await callTool(
      user,
      'get_messages',
      'list_messages',
      { room_id: roomId, limit: Math.min(opts.limit ?? 100, 100) },
      { priority: opts.priority },
    )

    const { nodes } = listOf(payload, 'roomStories', 'stories')
    return nodes.map((n) => toMessage(n, roomId))
  }

  async listContracts(user: ConnectedUser, opts: { statuses?: string[]; limit?: number } = {}) {
    const payload = await callTool(user, 'list_contracts', 'search', {
      ...(opts.statuses ? { contract_statuses: opts.statuses } : {}),
      limit: Math.min(opts.limit ?? 10, 10),
    })

    const root = asRecord(payload)
    const flat = arr(root.contracts)
    if (flat.length > 0) return flat.map((c) => toContract(asRecord(c), user.orgUid))

    const { nodes } = edges(payload, 'contractSearch')
    return nodes.map((n) => toContract(n, user.orgUid))
  }

  /**
   * Human-initiated only. The length check happens here as well as in the UI
   * because Upwork rejects over-long bodies outright, and silently truncating
   * someone's message to a client would be worse than refusing to send it.
   */
  async sendMessage(
    user: ConnectedUser,
    roomId: string,
    body: string,
    attachments: UploadedFile[] = [],
  ) {
    const trimmed = body.trim()
    // Upwork allows a message with files and no text; the portal follows suit
    // rather than making people type something to send a screenshot.
    if (!trimmed && attachments.length === 0) {
      throw new Error('Refusing to send an empty message')
    }
    if (trimmed.length > MESSAGE_MAX_LENGTH) {
      throw new Error(
        `Message is ${trimmed.length} characters; Upwork's limit is ${MESSAGE_MAX_LENGTH}. ` +
          `Shorten it rather than sending a truncated version.`,
      )
    }

    await callTool(user, 'send_message', 'send', {
      room_id: roomId,
      ...(trimmed ? { message: trimmed } : {}),
      ...(attachments.length > 0
        ? {
            file_attachments: attachments.map((a) => ({
              file_id: a.fileId,
              file_name: a.fileName,
              ...(a.imageId ? { image_id: a.imageId } : {}),
            })),
          }
        : {}),
    })
  }

  async listMilestones(user: ConnectedUser, contractId: string) {
    const payload = await callTool(user, 'list_milestones', 'list', { contract_id: contractId })

    const root = asRecord(payload)
    const flat = arr(root.milestones)
    if (flat.length > 0) return flat.map((m) => toMilestone(asRecord(m), contractId))

    const { nodes } = edges(payload, 'milestones')
    return nodes.map((n) => toMilestone(n, contractId))
  }
}

export const mcpTransport = new McpTransport()

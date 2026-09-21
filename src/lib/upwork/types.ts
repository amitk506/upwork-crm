/**
 * Domain types and the transport interface.
 *
 * Everything above this layer is ignorant of whether the data arrived via the
 * MCP server or the GraphQL API. That is the whole point: when the API key is
 * approved, `GraphQLTransport` drops in and nothing else changes.
 */

import type { DirectionSource } from './direction'

export type ConnectedUser = {
  userId: string
  upworkUserId: string
  orgUid: string
  accessToken: string
}

export type Room = {
  roomId: string
  orgUid: string
  roomName: string | null
  topic: string | null
  numUsers: number | null
  numUnread: number
  latestStoryId: string | null
  latestStoryAt: string | null
  latestSnippet: string | null
  createdAtUpwork: string | null
  /** When our profile last opened this room — anything newer arrived while we were away. */
  lastVisitedAt: string | null
  /** Upwork began returning these in Aug 2026; null on the older shape. */
  contractId?: string | null
  contractStatus?: string | null
}

export type Message = {
  storyId: string
  roomId: string
  authorId: string | null
  authorName: string | null
  isOutbound: boolean
  direction: 'outbound' | 'inbound' | 'unknown'
  directionSource: DirectionSource
  /** Upwork's actionVerb: 'posted' is a human message, anything else a system event. */
  actionVerb: string | null
  isSystem: boolean
  body: string | null
  attachments: unknown[]
  sentAt: string | null
  editedAt: string | null
}

/**
 * A proposal we sent, and the job posting it was for.
 *
 * The only route from a conversation to a job post: rooms carry a topic string
 * and nothing else — no job id, no contract id — while a proposal names the
 * marketplace posting outright. Verified against a live payload rather than
 * inferred, unlike the job and contract mappers alongside it.
 */
export type Proposal = {
  proposalId: string
  jobId: string | null
  jobTitle: string | null
  status: string | null
  statusLabel: string | null
  rateAmount: number | null
  rateCurrency: string | null
  createdAt: string | null
}

export type Contract = {
  contractId: string
  orgUid: string
  title: string | null
  clientName: string | null
  status: string | null
  contractType: string | null
  hourlyRate: number | null
  currency: string | null
  startedAt: string | null
  endedAt: string | null
}

export type Milestone = {
  milestoneId: string
  contractId: string
  title: string | null
  description: string | null
  state: string
  stateLabel: string | null
  depositAmount: number | null
  fundedAmount: number | null
  paidAmount: number | null
  currency: string | null
  submissionCount: number
  dueAt: string | null
  submittedAt: string | null
  deliverables: unknown[]
}

/**
 * Interactive work is a person waiting; background work is the sync loop.
 * Background stops at a lower daily cutoff so it can never starve someone
 * clicking in the UI. See lib/upwork/limits.ts.
 */
export type CallPriority = 'interactive' | 'background'

export type Page<T> = {
  items: T[]
  endCursor: string | null
  hasNextPage: boolean
}

/** A file uploaded to Upwork storage and ready to attach to a message. */
export type UploadedFile = {
  fileId: string
  fileName: string
  imageId?: string | null
  contentType: string | null
  size: number | null
}

export type PendingUpload = { name: string; type: string; size: number; base64: string }

export interface UpworkTransport {
  readonly name: 'mcp' | 'graphql'

  listRooms(
    user: ConnectedUser,
    opts?: { limit?: number; cursor?: string; priority?: CallPriority },
  ): Promise<Page<Room>>
  listMessages(
    user: ConnectedUser,
    roomId: string,
    opts?: { limit?: number; priority?: CallPriority },
  ): Promise<Message[]>
  listProposals(user: ConnectedUser, opts?: { priority?: CallPriority }): Promise<Proposal[]>
  uploadAttachments(
    user: ConnectedUser,
    roomId: string,
    files: PendingUpload[],
  ): Promise<UploadedFile[]>
  listContracts(user: ConnectedUser, opts?: { statuses?: string[]; limit?: number }): Promise<Contract[]>
  listMilestones(user: ConnectedUser, contractId: string): Promise<Milestone[]>
  listAccounts(user: ConnectedUser): Promise<{ name: string; orgUid: string; role: string }[]>

  /**
   * The only write in the interface. Always human-initiated: a person typed the
   * body and pressed send. Never call this from a timer, a retry, or a loop.
   */
  sendMessage(
    user: ConnectedUser,
    roomId: string,
    body: string,
    attachments?: UploadedFile[],
  ): Promise<void>
}

/** Upwork rejects anything longer; validate before sending, never truncate. */
export const MESSAGE_MAX_LENGTH = 10_240

/** Thrown when a call is refused locally, before any request reaches Upwork. */
export class UpworkPolicyError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'unknown_tool'
      | 'writes_disabled'
      | 'daily_budget_exhausted'
      | 'circuit_open'
      | 'not_connected',
  ) {
    super(message)
    this.name = 'UpworkPolicyError'
  }
}

/** Thrown when Upwork itself rejected the call. */
export class UpworkApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'UpworkApiError'
  }
}

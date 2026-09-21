import Link from 'next/link'

import { formatDateTime } from '@/lib/format'

export type ActivityEntry = {
  id: number
  actor_name: string | null
  action: string
  target_type: string | null
  target_id: string | null
  room_name: string | null
  payload: Record<string, unknown> | null
  succeeded: boolean | null
  error: string | null
  created_at: string
}

/**
 * What happened, in a full sentence.
 *
 * The feed used to render actor + verb + conversation, which produced lines like
 * "Agam Grover assigned Wesley Waxer" — reading as though Wesley had been
 * assigned somewhere, when it meant Agam handed the Wesley Waxer conversation to
 * a teammate whose name never appeared. Every routing and access entry has TWO
 * people in it, and the one being acted upon is usually the point: "who did
 * Nidhi give access to" is the question an owner is actually asking.
 *
 * The ids were always in the payload; only the rendering dropped them. So this
 * resolves them and builds a proper clause, and the same fix carries into the
 * conversation panel, where the room is already implied and a line without the
 * recipient said almost nothing.
 */

type Describer = (ctx: {
  payload: Record<string, unknown>
  person: (id: unknown) => string | null
  profile: (id: unknown) => string | null
  targetId: string | null
}) => { verb: string; to?: string | null; note?: string | null }

/**
 * One entry per action. Returning the recipient separately from the verb keeps
 * the word order right — "gave X access to <conversation>" and "assigned
 * <conversation> to X" put the same two names in opposite places.
 */
const DESCRIBE: Record<string, Describer> = {
  'inbox.replied': () => ({ verb: 'replied to' }),
  'inbox.reply_failed': () => ({ verb: 'failed to reply to' }),

  'inbox.assigned': ({ payload, person }) => ({
    verb: 'assigned',
    to: person(payload.assignedTo) ?? 'someone',
  }),
  'inbox.unassigned': () => ({ verb: 'took the assignee off' }),

  'inbox.reply_waived': () => ({ verb: 'marked no reply needed on' }),
  'inbox.followup_set': ({ payload, person }) => ({
    verb: 'set a follow-up on',
    to: person(payload.forUser),
  }),
  'inbox.followup_cleared': () => ({ verb: 'closed the follow-up on' }),
  'inbox.direction_corrected': ({ payload }) => ({
    verb: 'corrected who sent a message in',
    note: payload.direction === 'outbound' ? 'marked as ours' : 'marked as the client’s',
  }),
  'inbox.reply_unwaived': () => ({ verb: 'put back in the waiting list:' }),

  'draft.created': ({ payload, person }) => ({
    verb: 'wrote a draft for',
    to: person(payload.ownerId),
  }),
  // Approving a draft logs inbox.replied, not a draft.* action — the reply is the
  // thing that happened. Only the decline has its own entry, and it carries the
  // reason rather than an author id.
  'draft.declined': ({ payload }) => ({
    verb: 'declined a draft on',
    note: typeof payload.reason === 'string' && payload.reason ? `“${payload.reason}”` : null,
  }),
  'draft.send_failed': () => ({ verb: 'failed to send an approved draft for' }),

  'room.granted': ({ payload, person, profile }) => ({
    verb: `gave ${person(payload.userId) ?? 'a member'} access to`,
    note: profile(payload.profileId) ? `through ${profile(payload.profileId)}` : null,
  }),
  'room.grant_revoked': ({ payload, person }) => ({
    verb: `removed ${person(payload.userId) ?? 'a member'}’s access to`,
  }),

  'profile.granted': ({ payload, person, profile, targetId }) => ({
    verb: `gave ${person(payload.userId) ?? 'a member'} ${named(profile(targetId), 'profile')}`,
    note: payload.canSend === false ? 'read-only' : 'can send',
  }),
  'profile.grant_revoked': ({ payload, person, profile, targetId }) => ({
    verb: `took ${named(profile(targetId), 'profile')} away from ${person(payload.userId) ?? 'a member'}`,
  }),
  'profile.connected': ({ payload, profile, targetId }) => ({
    // The label is stored in the payload at the time, so it survives the profile
    // being disconnected later — which the id no longer does.
    verb: `connected ${named(asText(payload.label) ?? profile(targetId), 'profile')}`,
  }),
  'profile.connect_failed': () => ({ verb: 'failed to connect a profile' }),
  'profile.removed': ({ payload, profile, targetId }) => ({
    verb: `disconnected ${named(asText(payload.label) ?? profile(targetId), 'profile')}`,
  }),
  'profile.approval_enabled': ({ profile, targetId }) => ({
    verb: `turned on reply review for ${named(profile(targetId), 'profile')}`,
  }),
  'profile.approval_disabled': ({ profile, targetId }) => ({
    verb: `allowed direct send on ${named(profile(targetId), 'profile')}`,
  }),

  'team.member_invited': ({ person, targetId }) => ({ verb: `added ${person(targetId) ?? 'a member'}` }),
  'team.member_deactivated': ({ person, targetId }) => ({
    verb: `deactivated ${person(targetId) ?? 'a member'}`,
  }),
  'team.member_reactivated': ({ person, targetId }) => ({
    verb: `reactivated ${person(targetId) ?? 'a member'}`,
  }),
  'team.member_deleted': () => ({ verb: 'deleted a member' }),
  'team.member_renamed': ({ person, targetId }) => ({
    verb: `renamed ${person(targetId) ?? 'a member'}`,
  }),
  'team.role_changed': ({ payload, person, targetId }) => ({
    verb: `made ${person(targetId) ?? 'a member'} ${String(payload.role ?? '').replace('_', ' ')}`.trimEnd(),
  }),
  'team.password_reset': ({ person, targetId }) => ({
    verb: `reset ${person(targetId) ?? 'a member'}’s password`,
  }),

  'account.password_changed': () => ({ verb: 'changed their own password' }),
  'account.password_change_refused': () => ({ verb: 'entered the wrong current password' }),

  'upwork.connected': () => ({ verb: 'connected Upwork' }),
  'sync.tick': () => ({ verb: 'synced in the background' }),
  'review.end_of_day': ({ payload }) => ({
    verb: 'ran the end-of-day check',
    note:
      typeof payload.recorded === 'number'
        ? `${payload.recorded} conversation(s) ended the day unanswered`
        : null,
  }),
  'review.miss_confirmed': () => ({ verb: 'confirmed an unanswered conversation' }),
  'review.miss_dismissed': () => ({ verb: 'dismissed an unanswered conversation' }),
  'sync.tick_failed': () => ({ verb: 'background sync failed' }),
}

/**
 * "the Gayatri profile" when we know which, "a profile" when we do not.
 *
 * Needed because a grant recorded months ago points at a profile id that may
 * since have been disconnected, so the label genuinely cannot be resolved. The
 * naive fallback produced "gave Nidhi the a profile" — an entry that reads as a
 * rendering bug rather than as missing history.
 */
function named(label: string | null | undefined, noun: string): string {
  return label ? `the ${label} ${noun}` : `a ${noun}`
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** A last resort that is still readable: "inbox.reply_waived" → "reply waived". */
function humanise(action: string): string {
  return action.replace(/^[a-z]+\./, '').replace(/_/g, ' ')
}

export function ActivityFeed({
  entries,
  showRoom = true,
  empty = 'Nothing yet.',
  people = {},
  profiles = {},
}: {
  entries: ActivityEntry[]
  showRoom?: boolean
  empty?: string
  /** Member id → name, for resolving the person an action was done to. */
  people?: Record<string, string>
  /** Profile id → label. */
  profiles?: Record<string, string>
}) {
  if (entries.length === 0) {
    return <p className="text-xs text-soft">{empty}</p>
  }

  const person = (id: unknown) => (typeof id === 'string' ? (people[id] ?? null) : null)
  const profile = (id: unknown) => (typeof id === 'string' ? (profiles[id] ?? null) : null)

  return (
    <ul className="space-y-2">
      {entries.map((e) => {
        const payload = e.payload ?? {}
        const describer = DESCRIBE[e.action]
        const described = describer
          ? describer({ payload, person, profile, targetId: e.target_id })
          : { verb: humanise(e.action) }

        const failed = e.succeeded === false
        const viaApproval = (payload as { viaApproval?: boolean }).viaApproval
        const roomLabel = e.room_name ?? 'a conversation'

        return (
          <li key={e.id} className="text-xs">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className={failed ? 'text-stop' : 'text-ok'}>{failed ? '✕' : '✓'}</span>
              <span className="font-medium">{e.actor_name ?? 'system'}</span>
              <span className="text-soft">{described.verb}</span>

              {/* The conversation, when it is not already the thing you are looking at. */}
              {e.target_type === 'room' &&
                e.target_id &&
                (showRoom ? (
                  <Link
                    href={`/inbox/${e.target_id}`}
                    className="max-w-[18rem] truncate font-medium underline-offset-2 hover:underline"
                  >
                    {roomLabel}
                  </Link>
                ) : (
                  <span className="text-soft">this conversation</span>
                ))}

              {described.to && (
                <>
                  <span className="text-soft">to</span>
                  <span className="font-medium">{described.to}</span>
                </>
              )}

              <span className="tabular ml-auto shrink-0 text-faint">
                {formatDateTime(e.created_at)}
              </span>
            </div>

            {described.note && <p className="ml-5 text-[11px] text-faint">{described.note}</p>}
            {viaApproval && (
              <p className="ml-5 text-[11px] text-soft">sent from their profile after approval</p>
            )}
            {e.error && <p className="ml-5 text-[11px] text-stop">{e.error}</p>}
          </li>
        )
      })}
    </ul>
  )
}

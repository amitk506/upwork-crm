import Link from 'next/link'

import { ProfileAvatar } from '@/components/profile-avatar'
import { severityClass, WaitMeter } from '@/components/wait-meter'
import type { WaitState } from '@/lib/wait'

/**
 * One line of the inbox.
 *
 * Three states are kept deliberately separate, because collapsing them into a
 * single badge is what loses clients:
 *
 *   unread      — nobody has opened it. Heavier name, full-ink snippet, a dot.
 *   needs reply — the client spoke last. Carries the stripe and the meter, and
 *                 is INDEPENDENT of read state: a conversation someone opened,
 *                 read and never answered still needs a reply, and in a
 *                 recency-sorted list it looks identical to a resolved one.
 *   answered    — the meter disappears entirely. Done should look like nothing.
 *
 * Height is fixed at three text lines so a list of 200 rows scans as a column
 * rather than a ragged stack, and the meter's tabular figures mean a row never
 * reflows as its own duration ticks over.
 */
export function ConversationRow({
  roomId,
  name,
  topic,
  snippet,
  unread,
  profile,
  wait,
  assignee,
  showCoverage,
  selected = false,
}: {
  roomId: string
  name: string
  topic: string | null
  snippet: string | null
  unread: number
  profile: { id: string; label: string } | null
  wait: WaitState
  /** Null means nobody owns it — a fault, not a neutral fact. */
  assignee: { name: string; isMe: boolean } | null
  /** Owners and managers route work, so they are the ones told about gaps. */
  showCoverage: boolean
  selected?: boolean
}) {
  const isUnread = unread > 0

  return (
    <Link
      href={`/inbox/${roomId}`}
      data-selected={selected || undefined}
      aria-current={selected ? 'page' : undefined}
      className={[
        'stripe grid grid-cols-[34px_minmax(0,1fr)_auto] items-start gap-3',
        'py-[11px] pl-[17px] pr-3.5 transition-colors',
        severityClass(wait),
        selected ? 'bg-accent-tint' : 'hover:bg-sunk',
      ].join(' ')}
    >
      {profile ? (
        <ProfileAvatar profileId={profile.id} label={profile.label} size="md" />
      ) : (
        <span className="h-[34px] w-[34px] rounded-[9px] border border-dashed border-line-strong" />
      )}

      <div className="min-w-0">
        <p
          className={`truncate text-[13px] ${isUnread ? 'font-bold' : 'font-semibold'}`}
          title={name}
        >
          {name}
        </p>

        {topic && <p className="mt-px truncate text-[11.5px] text-faint">{topic}</p>}

        {snippet && (
          <p
            className={`mt-1 truncate text-[12.5px] ${isUnread ? 'font-medium text-ink' : 'text-soft'}`}
          >
            {snippet}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5 text-right">
        {isUnread && (
          <span
            aria-label={`${unread} unread`}
            className="h-[7px] w-[7px] rounded-full bg-accent"
          />
        )}

        <WaitMeter state={wait} />

        {assignee ? (
          <span className="truncate rounded-full border border-line-strong px-[7px] text-[10px] font-semibold text-faint">
            {assignee.isMe ? 'You' : assignee.name}
          </span>
        ) : (
          showCoverage && (
            <span className="rounded-full border border-stop/40 px-[7px] text-[10px] font-semibold text-stop">
              Unassigned
            </span>
          )
        )}
      </div>
    </Link>
  )
}

/** "Vansh Kapoor" → "Vansh K." — a 336px column has room for one surname letter. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Someone'
  if (parts.length === 1) return parts[0]!
  return `${parts[0]} ${parts[1]![0]!.toUpperCase()}.`
}

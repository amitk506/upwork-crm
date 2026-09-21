import { formatDateTime } from '@/lib/format'
import { WAIT_LEVEL_LABEL, type WaitState } from '@/lib/wait'

/**
 * The one figure the whole product organises around.
 *
 * A dot plus a duration, and the dot is what carries the level — the colour of a
 * six-character string is not reliably readable at 11.5px, while a 6px disc is.
 * A breach gets a halo on top of the colour so it survives greyscale.
 *
 * Rendered server-side from a counted duration rather than ticking in the
 * browser: a room list of 200 rows each running its own interval is a lot of
 * wasted work to move a digit that only matters at a minute's resolution, and
 * the page already revalidates on the sync heartbeat.
 */

const LEVEL: Record<'fresh' | 'watch' | 'late' | 'breached', string> = {
  fresh: 'text-faint',
  watch: 'text-watch',
  late: 'text-warn',
  breached: 'text-stop',
}

export function severityClass(state: WaitState): string {
  return state.awaiting ? `sev-${state.level}` : 'sev-fresh'
}

export function WaitMeter({ state }: { state: WaitState }) {
  if (!state.awaiting) {
    if (state.waived) {
      return (
        <span
          className="text-[11px] text-faint"
          title="Someone marked this as not needing an answer. The timer returns on its own if the client writes again."
        >
          No reply needed
        </span>
      )
    }

    if (state.unknown) {
      return (
        <span className="text-[11px] text-faint" title="Upwork did not tell us who sent these">
          Sender unclear
        </span>
      )
    }
    return (
      <span className="text-[11px] text-faint">
        {state.repliedAt ? `Replied ${shortAgo(state.repliedAt)}` : 'No messages'}
      </span>
    )
  }

  return (
    <span
      className={`tabular inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-semibold ${LEVEL[state.level]}`}
      title={
        `${WAIT_LEVEL_LABEL[state.level]} — waiting since ${formatDateTime(state.since)}. ` +
        'Overnight hours between 10 PM and 8 AM IST are not counted. ' +
        (state.inferred
          ? 'Approximate: Upwork does not report who sent a message, so this side was worked out from the conversation’s turn-taking.'
          : 'Who spoke last is known, not guessed.')
      }
    >
      <span
        aria-hidden
        className={[
          'h-1.5 w-1.5 shrink-0 rounded-full',
          // Hollow when the attribution is a guess: same position, same colour,
          // visibly less certain. Filled means we know who spoke last.
          state.inferred ? 'border-[1.5px] border-current' : 'bg-current',
          state.level === 'breached' && !state.inferred ? 'ring-[3px] ring-stop/25' : '',
        ].join(' ')}
      />
      {state.inferred && <span aria-hidden>~</span>}
      {state.label}
    </span>
  )
}

/** "3h", "2d" — enough to say "recently" without a second precise timestamp. */
function shortAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (!Number.isFinite(minutes)) return 'earlier'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

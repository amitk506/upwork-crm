import Link from 'next/link'

import type { SyncGaps } from '@/lib/database.types'

/**
 * "These conversations have stopped updating."
 *
 * An OAuth refresh token expiring is the quietest serious failure this portal
 * has: the profile keeps existing, its conversations keep sitting in the inbox
 * looking normal, and nothing about them updates again. It was only visible in a
 * database column and a JSON field in the sync response.
 *
 * Deliberately worded as consequence first and cause second. "Reconnect the
 * profile" is the fix, but "23 conversations are not updating" is the reason
 * anyone should care, and it is what makes this worth interrupting someone for.
 */
export function SyncGapNotice({ gaps }: { gaps: SyncGaps | null }) {
  if (!gaps) return null
  if (gaps.profiles_broken === 0 && gaps.rooms_unreachable === 0) return null

  const labels = gaps.broken_labels ?? []

  return (
    <div className="rounded-[--radius] border border-stop/40 bg-stop-tint px-4 py-3">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-stop">
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 fill-none stroke-current"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M12 4l9 16H3z" />
          <path d="M12 10v4M12 17h.01" />
        </svg>
        {gaps.rooms_unreachable > 0 ? (
          <>
            <span className="tabular">{gaps.rooms_unreachable}</span>
            {gaps.rooms_unreachable === 1 ? ' conversation is' : ' conversations are'} not updating
          </>
        ) : (
          <>
            <span className="tabular">{gaps.profiles_broken}</span>
            {gaps.profiles_broken === 1 ? ' profile needs' : ' profiles need'} reconnecting
          </>
        )}
      </p>

      <p className="mt-1 max-w-[70ch] text-[12.5px] text-soft">
        {labels.length > 0 ? (
          <>
            Upwork stopped accepting the saved authorisation for{' '}
            <span className="font-semibold text-ink">{labels.join(', ')}</span>, so the portal can
            no longer read or reply to anything on{' '}
            {labels.length === 1 ? 'that profile' : 'those profiles'}. Nobody is being told a client
            is waiting there, because the portal cannot see.
          </>
        ) : (
          <>
            No connected profile can reach these conversations, so their messages and wait times
            have stopped refreshing. They usually belonged to a profile that was disconnected.
          </>
        )}
      </p>

      <Link
        href="/profiles"
        className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-stop underline underline-offset-2"
      >
        Reconnect under Profiles
      </Link>
    </div>
  )
}

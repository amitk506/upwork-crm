import Link from 'next/link'

import { AppShell } from '@/components/app-shell'
import { ReviewActions } from '@/components/review-actions'
import { PageHead } from '@/components/ui'
import { requireCapability } from '@/lib/auth'
import { formatDate, formatDateTime } from '@/lib/format'
import { createClient } from '@/lib/supabase/server'
import { formatWait } from '@/lib/wait'

/**
 * Conversations that ended a working day unanswered, waiting on a human.
 *
 * Deliberately not a list of offences. Each row shows the evidence — how long,
 * whose it was, and crucially whether the portal actually KNOWS the client spoke
 * last or merely inferred it. Today almost none are known, so the queue leads
 * with that rather than burying it.
 */
export default async function ReviewsPage() {
  const user = await requireCapability('inbox:assign')
  const supabase = await createClient()

  const { data: misses } = await supabase
    .from('reply_misses')
    .select('*')
    .order('miss_date', { ascending: false })
    .order('waited_seconds', { ascending: false })
    .limit(200)

  const all = misses ?? []
  const pending = all.filter((m) => m.status === 'pending')
  const uncertain = pending.filter((m) => !m.attribution_certain).length

  return (
    <AppShell user={user}>
      <PageHead
        title="End-of-day review"
        meta="Conversations that finished a working day without a reply. Confirmed misses are the only ones eligible to reach HR."
      />

      {pending.length === 0 ? (
        <div className="rounded-[--radius] border border-line bg-surface px-6 py-10 text-center">
          <p className="text-sm font-medium">Nothing to review.</p>
          <p className="mt-1 text-sm text-soft">
            Every working day so far has ended with its assigned conversations answered, or the
            misses have already been reviewed.
          </p>
        </div>
      ) : (
        <>
          {uncertain > 0 && (
            <p className="mb-4 rounded-[--radius] border border-warn/35 bg-warn-tint px-4 py-3 text-[12.5px] text-warn">
              <span className="tabular font-semibold">{uncertain}</span> of these rest on the
              portal&apos;s guess about who spoke last, not on a recorded fact. Upwork does not
              report message senders, so a reply your team sent from the Upwork app can look
              identical to a client&apos;s. Check the conversation before confirming.
            </p>
          )}

          <div className="overflow-hidden rounded-[--radius] border border-line bg-surface">
            <ul>
              {pending.map((miss) => (
                <li key={miss.id} className="border-b border-line px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-[13px] font-semibold">{miss.employee_name}</span>
                    <span className="text-[12px] text-faint">did not reply to</span>
                    <Link
                      href={`/inbox/${miss.room_id}`}
                      className="text-[13px] font-semibold underline-offset-2 hover:underline"
                    >
                      {miss.room_name ?? 'a conversation'}
                    </Link>
                    <span className="tabular ml-auto text-[11.5px] text-faint">
                      {formatDate(miss.miss_date)}
                    </span>
                  </div>

                  <p className="tabular mt-1 text-[11.5px] text-faint">
                    Client wrote {formatDateTime(miss.awaiting_since)} · unanswered for{' '}
                    <span className="font-semibold text-warn">
                      {formatWait(miss.waited_seconds)}
                    </span>
                    {miss.attribution_certain ? (
                      <span className="text-ok"> · sender known</span>
                    ) : (
                      <span className="text-warn">
                        {' '}
                        · sender inferred ({miss.attribution ?? 'unknown'})
                      </span>
                    )}
                  </p>

                  <div className="mt-2">
                    <ReviewActions id={miss.id} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <p className="mt-4 max-w-[70ch] text-xs text-faint">
        A conversation counts only if it had an assignee, the client wrote before 11 PM IST, the day
        was a working day per the holiday list your HR system publishes, and nobody had marked it
        as needing no reply. Weekends and holidays are skipped entirely.
      </p>
    </AppShell>
  )
}

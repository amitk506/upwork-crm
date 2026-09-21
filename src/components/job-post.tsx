import { formatDate } from '@/lib/format'
import { formatRate, type JobMatch } from '@/lib/upwork/job-match'

/**
 * The job post this conversation came from.
 *
 * Shown only when it is certain. Upwork gives no id linking a room to a posting,
 * so the two are joined on the job title — reliable for a distinctive one,
 * useless for "SEO Specialist", which six of these conversations share. When
 * several proposals fit, the panel says so and shows nothing else: a rate and a
 * status are exactly the sort of detail that looks authoritative, and putting one
 * client's on another's conversation would be worse than leaving the question
 * unanswered.
 */
export function JobPost({ match }: { match: JobMatch }) {
  if (match.kind === 'none') return null

  if (match.kind === 'ambiguous') {
    return (
      <section className="rounded-[--radius] border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Job post</h2>
        <p className="mt-1 text-xs text-soft">
          <span className="tabular">{match.count}</span> proposals share this job title, so the
          portal cannot tell which one this conversation is about. Upwork does not link a
          conversation to a posting, so the match is made on the title alone.
        </p>
      </section>
    )
  }

  const { proposal } = match
  const rate = formatRate(proposal.rateAmount, proposal.rateCurrency)

  return (
    <section className="rounded-[--radius] border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold">Job post</h2>

      <p className="mt-1.5 text-[13px] font-semibold leading-snug">{proposal.jobTitle}</p>

      <dl className="mt-2 space-y-1">
        {proposal.statusLabel && (
          <div className="flex justify-between gap-3 text-xs">
            <dt className="text-faint">Proposal</dt>
            <dd className="font-medium">
              {proposal.statusLabel}
              {proposal.status && proposal.status !== proposal.statusLabel && (
                <span className="text-soft"> · {proposal.status}</span>
              )}
            </dd>
          </div>
        )}
        {rate && (
          <div className="flex justify-between gap-3 text-xs">
            <dt className="text-faint">You bid</dt>
            <dd className="tabular font-medium">{rate}</dd>
          </div>
        )}
        {proposal.createdAt && (
          <div className="flex justify-between gap-3 text-xs">
            <dt className="text-faint">Submitted</dt>
            <dd className="tabular font-medium">{formatDate(proposal.createdAt)}</dd>
          </div>
        )}
      </dl>

      <p className="mt-2 text-[11px] text-faint">
        Matched by job title — Upwork exposes no id tying a conversation to a posting.
      </p>
    </section>
  )
}

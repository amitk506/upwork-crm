/**
 * Matching a conversation to the job post it came from.
 *
 * Upwork gives no shared key: a room carries a `topic` and a proposal carries a
 * `marketplaceJobPosting.content.title`, and in practice they are the same
 * string. So the join is on the title, which makes it a heuristic rather than a
 * lookup — and heuristics in this codebase have to declare themselves.
 *
 * The rule is deliberately strict: report a match only when exactly ONE proposal
 * normalises to the same title. Six of the agency's rooms share the topic "SEO
 * Specialist"; picking one of six proposals to display would put a specific
 * client's rate and status on the wrong conversation, which is worse than
 * showing nothing.
 */

export type MatchableProposal = {
  proposalId: string
  jobId: string | null
  jobTitle: string | null
  status: string | null
  statusLabel: string | null
  rateAmount: number | null
  rateCurrency: string | null
  createdAt: string | null
}

export type JobMatch =
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number; title: string }
  | { kind: 'match'; proposal: MatchableProposal }

/**
 * Case, spacing and punctuation are all noise here — "Shopify SEO specialist"
 * and "Shopify SEO Specialist" are the same job.
 */
export function normalizeTitle(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .toLowerCase()
    .normalize('NFKD')
    // Curly quotes and dashes travel differently through Upwork's encoding than
    // the ones a person typed.
    .replace(/[‘’“”]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function matchJob(
  roomTopic: string | null | undefined,
  proposals: MatchableProposal[],
): JobMatch {
  const topic = normalizeTitle(roomTopic)
  if (!topic) return { kind: 'none' }

  const hits = proposals.filter((p) => normalizeTitle(p.jobTitle) === topic)
  if (hits.length === 0) return { kind: 'none' }
  if (hits.length > 1) return { kind: 'ambiguous', count: hits.length, title: roomTopic ?? '' }

  return { kind: 'match', proposal: hits[0]! }
}

/** "USD 8.00 / hr" — Upwork reports the bid as a charge rate. */
export function formatRate(amount: number | null, currency: string | null): string | null {
  if (amount === null || !Number.isFinite(amount)) return null
  return `${currency ?? ''} ${amount.toFixed(2)}`.trim()
}

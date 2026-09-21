import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatRate, matchJob, normalizeTitle, type MatchableProposal } from './job-match.ts'

const proposal = (title: string, id = title): MatchableProposal => ({
  proposalId: `p-${id}`,
  jobId: `j-${id}`,
  jobTitle: title,
  status: 'Accepted',
  statusLabel: 'Submitted',
  rateAmount: 8,
  rateCurrency: 'USD',
  createdAt: '2026-08-18T07:22:56.656Z',
})

test('case and punctuation are noise', () => {
  assert.equal(normalizeTitle('Shopify SEO specialist'), normalizeTitle('Shopify SEO Specialist'))
  assert.equal(normalizeTitle('Technical SEO + AEO Lead'), 'technical seo aeo lead')
  assert.equal(normalizeTitle('  spaced   out  '), 'spaced out')
  assert.equal(normalizeTitle(null), '')
})

test('curly quotes and long dashes normalise to their plain forms', () => {
  // Upwork's encoding round-trips these differently from what a person typed.
  assert.equal(normalizeTitle('Client’s SEO — audit'), normalizeTitle("Client's SEO - audit"))
})

test('a distinctive title matches its proposal', () => {
  const result = matchJob('Automotive SEO Specialist for Dealership Group', [
    proposal('SEO Specialist'),
    proposal('Automotive SEO Specialist for Dealership Group'),
  ])
  assert.equal(result.kind, 'match')
  assert.equal(result.kind === 'match' && result.proposal.jobTitle, 'Automotive SEO Specialist for Dealership Group')
})

test('a title shared by several proposals reports ambiguous, never a guess', () => {
  // Six of the agency's rooms are called "SEO Specialist". Showing one client's
  // rate on another's conversation is worse than showing nothing.
  const result = matchJob('SEO Specialist', [
    proposal('SEO Specialist', 'a'),
    proposal('SEO specialist', 'b'),
    proposal('Something else', 'c'),
  ])
  assert.equal(result.kind, 'ambiguous')
  assert.equal(result.kind === 'ambiguous' && result.count, 2)
})

test('no proposal, no match', () => {
  assert.equal(matchJob('A job nobody bid on', [proposal('Other')]).kind, 'none')
  assert.equal(matchJob(null, [proposal('Other')]).kind, 'none')
  assert.equal(matchJob('', []).kind, 'none')
})

test('an empty topic never matches a proposal with an empty title', () => {
  // Both normalise to '', which would otherwise pair every untitled room with
  // every untitled proposal.
  assert.equal(matchJob('   ', [{ ...proposal('x'), jobTitle: null }]).kind, 'none')
})

test('rates read as money', () => {
  assert.equal(formatRate(8, 'USD'), 'USD 8.00')
  assert.equal(formatRate(12.5, null), '12.50')
  assert.equal(formatRate(null, 'USD'), null)
  assert.equal(formatRate(Number.NaN, 'USD'), null)
})

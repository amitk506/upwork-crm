/**
 * Cleaning up Upwork message text for display.
 *
 * Three transformations, all verified against real payloads:
 *   1. <untrusted_participant_content> wrappers — a prompt-injection guard for
 *      model consumers, meaningless in a browser
 *   2. HTML entities — Upwork returns escaped text, so "&amp;" showed literally
 *   3. mention markup — `<@123:456|Max Castiel>` rendered raw in the thread
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/**
 * `<@424177617406902272:425230075412246528|William Kreitzmann>` → `@William Kreitzmann`
 * The ids are internal and mean nothing to a reader.
 */
export function renderMentions(input: string): string {
  return input.replace(/<@[^|>]*\|([^>]+)>/g, (_match, name: string) => `@${name.trim()}`)
}

/** Full pipeline for anything shown in the UI. */
export function cleanMessageText(value: string | null | undefined): string | null {
  if (!value) return null

  const cleaned = renderMentions(
    decodeEntities(value.replace(/<\/?untrusted_participant_content>/g, '')),
  ).trim()

  return cleaned === '' ? null : cleaned
}

/**
 * Upwork's actionVerb. 'posted' means a person wrote it; everything else
 * ('invited', 'accepted', 'sent', …) is a system event and should not be
 * rendered as if someone said it.
 */
export function isSystemEvent(actionVerb: string | null | undefined): boolean {
  return Boolean(actionVerb) && actionVerb !== 'posted'
}

/**
 * Upwork's stand-in body for a message it will not hand over in full.
 *
 * Sent verbatim as the message text — "System event: posted. View this
 * conversation on upwork.com for full context." — on 43 of this agency's
 * messages, almost all of them a file with no caption. Rendering it tells the
 * reader nothing and points them away from the portal, so the interface treats it
 * as no text at all and shows the attachment instead.
 *
 * Matched on shape rather than the exact sentence, since the verb varies
 * (posted, created, sent) and the wording is Upwork's to change.
 */
const PLACEHOLDER = /^System event: \w+\.\s*View this conversation on upwork\.com/i

export function isUpworkPlaceholder(body: string | null | undefined): boolean {
  return typeof body === 'string' && PLACEHOLDER.test(body.trim())
}

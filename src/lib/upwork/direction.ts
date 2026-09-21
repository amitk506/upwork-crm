/**
 * Working out which side a message came from.
 *
 * Upwork tells us nothing about the sender, so this infers it from what is
 * available. Every result carries its source so the UI can distinguish a fact
 * from a strong guess — showing an inference as certain would be worse than
 * showing nothing.
 */

export type Direction = 'outbound' | 'inbound' | 'unknown'
export type DirectionSource =
  | 'portal_send'
  /** A person told us. Outranks everything the portal could work out itself. */
  | 'corrected'
  /** Upwork named the uploader of an attached file. Not a guess. */
  | 'attachment_author'
  | 'mention'
  | 'visit_window'
  /** Sent seconds after a message whose side we know — the same person still typing. */
  | 'burst'
  /** Derived by assuming the thread takes turns. Weakest signal; see alternation.ts. */
  | 'alternation'
  | null

/**
 * How much weight the interface may put on a direction.
 *
 * This matters because the wait meter is built on direction: a wrong 'inbound'
 * invents a client who is waiting, and a ramp that cries wolf gets ignored. So
 * anything derived by alternation is labelled, and the meter shows it as
 * approximate rather than presenting a guess as a fact.
 */
export type DirectionConfidence = 'certain' | 'strong' | 'inferred'

export function directionConfidence(source: DirectionSource): DirectionConfidence {
  if (source === 'portal_send' || source === 'corrected' || source === 'attachment_author') {
    return 'certain'
  }
  if (source === 'alternation') return 'inferred'
  return 'strong'
}

export type DirectionResult = { direction: Direction; source: DirectionSource }

/**
 * The other participant's display name, as Upwork reports it on the room.
 * Room names look like "Max Castiel" or "Wesley Waxer, UMT" — the leading part
 * before a comma is the person.
 */
export function counterpartNames(roomName: string | null | undefined): string[] {
  if (!roomName) return []

  const person = roomName.split(',')[0]!.trim()
  if (!person) return []

  const names = new Set<string>([person])
  // First name alone, because greetings use it: "Hi William,"
  const first = person.split(/\s+/)[0]
  if (first && first.length >= 3) names.add(first)

  return [...names]
}

/**
 * Does this message address the other participant by name?
 *
 * Two forms, both seen in real threads:
 *   "<@123:456|William Kreitzmann> have you had a chance…"  (mention markup)
 *   "Hi William,"                                            (greeting)
 *
 * Nobody addresses themselves, so a match means the message is ours. The
 * greeting form is anchored to the start of the message on purpose — a name
 * appearing mid-sentence ("I spoke to William") says nothing about the sender.
 */
export function addressesCounterpart(body: string, names: string[]): boolean {
  if (!body || names.length === 0) return false

  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    // Mention markup, before or after the display name is rendered
    if (new RegExp(`<@[^|>]*\\|\\s*${escaped}\\b`, 'i').test(body)) return true
    if (new RegExp(`@${escaped}\\b`, 'i').test(body)) return true

    // Greeting in the opening line
    if (new RegExp(`^\\s*(hi|hey|hello|dear)\\s+${escaped}\\b`, 'i').test(body)) return true
  }

  return false
}

export function inferDirection(input: {
  body: string | null
  sentAt: string | null
  /** true when this message body matches one we recorded sending ourselves */
  sentFromPortal: boolean
  roomName: string | null
  /** when our profile last opened this room, per Upwork */
  lastVisitedAt: string | null
}): DirectionResult {
  // 1. We recorded sending it. Not an inference.
  if (input.sentFromPortal) return { direction: 'outbound', source: 'portal_send' }

  const body = input.body ?? ''

  // 2. It addresses the other participant, so it is not from them.
  if (addressesCounterpart(body, counterpartNames(input.roomName))) {
    return { direction: 'outbound', source: 'mention' }
  }

  // 3. It landed after we last opened the room, so it arrived while we were
  //    away — which our own outgoing messages do not do.
  if (input.sentAt && input.lastVisitedAt) {
    if (new Date(input.sentAt).getTime() > new Date(input.lastVisitedAt).getTime()) {
      return { direction: 'inbound', source: 'visit_window' }
    }
  }

  return { direction: 'unknown', source: null }
}

/** How the UI should caption a message, given what we actually know. */
export function directionLabel(
  direction: Direction,
  source: DirectionSource,
  opts: { senderName?: string | null; counterpartName?: string | null },
): { label: string; certain: boolean } {
  if (direction === 'outbound') {
    return {
      label: source === 'portal_send' ? (opts.senderName ?? 'You') : 'Your side',
      certain: source === 'portal_send',
    }
  }

  if (direction === 'inbound') {
    return { label: opts.counterpartName ?? 'Client', certain: false }
  }

  return { label: 'Sender not shown by Upwork', certain: false }
}

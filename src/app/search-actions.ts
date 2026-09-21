'use server'

import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { can } from '@/lib/permissions'

/**
 * Portal-wide search.
 *
 * Reads ONLY what the portal already holds. It never calls Upwork — a search box
 * that fanned out to their API would spend the daily budget on keystrokes, and at
 * six requests a second a single impatient typist could trip the limiter for
 * everyone. Every hit here is a row already in the database.
 *
 * Runs through the member's own client, so RLS decides the scope: rooms they can
 * see, notes on conversations they hold. Nothing about scoping is arranged in
 * this file, which is the point — search is exactly the surface where a
 * hand-rolled filter tends to forget a case.
 */

export type SearchHit =
  | { kind: 'room'; id: string; title: string; detail: string | null; href: string }
  | { kind: 'note'; id: string; title: string; detail: string; href: string }
  | { kind: 'member'; id: string; title: string; detail: string; href: string }

export type SearchResults = {
  query: string
  rooms: SearchHit[]
  notes: SearchHit[]
  members: SearchHit[]
  truncated: boolean
}

const EMPTY: SearchResults = { query: '', rooms: [], notes: [], members: [], truncated: false }

/** PostgREST passes the pattern to ILIKE, so the wildcards need neutralising. */
function escapeLike(term: string): string {
  return term.replace(/[%_\\]/g, '\\$&')
}

export async function searchPortal(rawQuery: string): Promise<SearchResults> {
  const user = await requireUser()
  const query = rawQuery.trim()
  if (query.length < 2) return { ...EMPTY, query }

  const supabase = await createClient()
  const pattern = `%${escapeLike(query)}%`
  const LIMIT = 8

  const [{ data: rooms }, { data: notes }, { data: members }] = await Promise.all([
    supabase
      .from('up_rooms')
      .select('room_id, room_name, topic, latest_snippet, latest_story_at')
      .or(`room_name.ilike.${pattern},topic.ilike.${pattern},latest_snippet.ilike.${pattern}`)
      .order('latest_story_at', { ascending: false, nullsFirst: false })
      .limit(LIMIT + 1),
    supabase
      .from('internal_notes')
      .select('id, body, target_id, created_at')
      .eq('target_type', 'room')
      .ilike('body', pattern)
      .order('created_at', { ascending: false })
      .limit(LIMIT),
    // Only for the people who route work; a bidder has no use for a roster and
    // no business enumerating one.
    can(user, 'team:manage')
      ? supabase
          .from('app_users')
          .select('id, full_name, email, role')
          .eq('is_active', true)
          .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
          .limit(4)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string; role: string }[] }),
  ])

  const roomHits = (rooms ?? []).slice(0, LIMIT).map(
    (room): SearchHit => ({
      kind: 'room',
      id: room.room_id,
      title: room.room_name ?? 'Conversation',
      // Prefer the line that actually matched, so you can see why it is here.
      detail: pick(query, [room.topic, room.latest_snippet]),
      href: `/inbox/${room.room_id}`,
    }),
  )

  return {
    query,
    rooms: roomHits,
    notes: (notes ?? []).map(
      (note): SearchHit => ({
        kind: 'note',
        id: note.id,
        title: 'Internal note',
        detail: excerpt(note.body, query),
        href: `/inbox/${note.target_id}`,
      }),
    ),
    members: (members ?? []).map(
      (member): SearchHit => ({
        kind: 'member',
        id: member.id,
        title: member.full_name || member.email,
        detail: member.role.replace('_', ' '),
        href: `/inbox?user=${member.id}&view=all`,
      }),
    ),
    truncated: (rooms ?? []).length > LIMIT,
  }
}

/** The first candidate containing the query, else the first that exists. */
function pick(query: string, candidates: (string | null)[]): string | null {
  const needle = query.toLowerCase()
  return (
    candidates.find((c) => c && c.toLowerCase().includes(needle)) ??
    candidates.find(Boolean) ??
    null
  )
}

/** A window around the match, because the point is to see the matched sentence. */
function excerpt(body: string, query: string, width = 90): string {
  const at = body.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return body.slice(0, width)

  const start = Math.max(0, at - Math.floor(width / 3))
  const text = body.slice(start, start + width).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${text}${start + width < body.length ? '…' : ''}`
}

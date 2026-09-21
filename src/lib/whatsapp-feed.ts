import { serverEnv } from '@/lib/env'

/**
 * The WhatsApp portal's waiting list, for the combined board.
 *
 * Fetched server-side so the feed token never reaches a browser, and deliberately
 * fail-soft: if that host is slow or down the board still renders its Upwork rows
 * rather than 500-ing. A board that shows half the picture beats a board that
 * shows nothing.
 */

export type WhatsAppWaitingRow = {
  id: string
  source: 'whatsapp'
  client: string
  profile: string | null
  project: string | null
  owner: string | null
  waitingSince: string
}

export async function fetchWhatsAppWaiting(): Promise<{
  rows: WhatsAppWaitingRow[]
  reachable: boolean
  configured: boolean
}> {
  const env = serverEnv()
  const url = env.WHATSAPP_FEED_URL
  const token = env.WHATSAPP_FEED_TOKEN
  if (!url || !token) return { rows: [], reachable: true, configured: false }

  try {
    // A wall board refreshes every 20s, so a slow feed must never hold it up.
    const res = await fetch(`${url}?token=${encodeURIComponent(token)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return { rows: [], reachable: false, configured: true }

    const body = (await res.json()) as { rows?: unknown }
    const rows = Array.isArray(body.rows) ? (body.rows as WhatsAppWaitingRow[]) : []
    // Only keep rows we can actually place on the board.
    return {
      rows: rows.filter((r) => r && typeof r.client === 'string' && typeof r.waitingSince === 'string'),
      reachable: true,
      configured: true,
    }
  } catch {
    return { rows: [], reachable: false, configured: true }
  }
}

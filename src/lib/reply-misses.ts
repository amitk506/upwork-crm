import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { serverEnv } from '@/lib/env'
import { fetchHolidays, istDateOf, istHourOf, isWorkingDay } from '@/lib/holidays'
import { countedWaitSeconds } from '@/lib/wait'

/**
 * The end-of-day check: which conversations finished a working day unanswered.
 *
 * Runs at IST midnight and looks back over the day that just ended. Four rules
 * decide whether a conversation counts, and each exists to keep a person's
 * record fair:
 *
 *   · it must have an assignee — "somebody should have replied" is not a
 *     finding, and 92% of conversations currently have no owner at all
 *   · the client's message must have arrived before 23:00 IST, so nothing
 *     landing minutes before midnight becomes a miss
 *   · the day must be a working day per the HR holiday list and the weekend
 *   · a waived conversation ("no reply needed") is not a miss, and neither is a
 *     dormant one
 *
 * Everything it finds lands in a review queue. Nothing here writes to HR.
 */

/** A client message arriving after this IST hour cannot be missed that day. */
export const CUTOFF_HOUR_IST = 23

type MissRow = {
  miss_date: string
  room_id: string
  room_name: string | null
  employee_id: string
  employee_name: string
  awaiting_since: string
  waited_seconds: number
  attribution: string | null
  attribution_certain: boolean
}

export type MissRun = {
  date: string
  skipped?: 'not-a-working-day' | 'holidays-unavailable'
  examined: number
  recorded: number
  reason?: string
}

export async function runEndOfDayCheck(now: Date = new Date()): Promise<MissRun> {
  // The job runs just after midnight, so the day being judged is the one that
  // just ended — not the few minutes of today.
  const yesterday = new Date(now.getTime() - 60 * 60 * 1000)
  const date = istDateOf(yesterday)

  let holidays: Set<string>
  try {
    holidays = await fetchHolidays(Number(date.slice(0, 4)), serverEnv().HOLIDAYS_URL)
  } catch (err) {
    // Without the list we cannot tell a holiday from a working day, and guessing
    // would log misses against people who were not at work.
    return {
      date,
      skipped: 'holidays-unavailable',
      examined: 0,
      recorded: 0,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  if (!isWorkingDay(date, holidays)) {
    return { date, skipped: 'not-a-working-day', examined: 0, recorded: 0 }
  }

  const supabase = createAdminClient()

  const [{ data: states }, { data: assignments }, { data: members }, { data: rooms }] =
    await Promise.all([
      supabase
        .from('room_reply_state')
        .select('room_id, awaiting_since, attribution, waived_for')
        .not('awaiting_since', 'is', null),
      supabase.from('assignments').select('target_id, assigned_to').eq('target_type', 'room'),
      supabase.from('app_users').select('id, full_name, email').eq('is_active', true),
      supabase.from('up_rooms').select('room_id, room_name'),
    ])

  const assignee = new Map((assignments ?? []).map((a) => [a.target_id, a.assigned_to] as const))
  const person = new Map((members ?? []).map((m) => [m.id, m.full_name || m.email] as const))
  const roomName = new Map((rooms ?? []).map((r) => [r.room_id, r.room_name] as const))

  const rows: MissRow[] = []
  let examined = 0

  for (const state of states ?? []) {
    if (!state.awaiting_since) continue
    examined++

    // Someone has to own it.
    const owner = assignee.get(state.room_id)
    if (!owner || !person.has(owner)) continue

    // Already dismissed by a human as needing no answer.
    if (state.waived_for && state.waived_for === state.awaiting_since) continue

    const arrived = new Date(state.awaiting_since)
    // Only the day that just ended, and only before the cutoff.
    if (istDateOf(arrived) !== date) continue
    if (istHourOf(arrived) >= CUTOFF_HOUR_IST) continue

    rows.push({
      miss_date: date,
      room_id: state.room_id,
      room_name: roomName.get(state.room_id) ?? null,
      employee_id: owner,
      employee_name: person.get(owner)!,
      awaiting_since: state.awaiting_since,
      waited_seconds: countedWaitSeconds(state.awaiting_since, now),
      attribution: state.attribution,
      // Only a portal send or a human correction is a fact. Everything else is
      // the portal's own guess, and the reviewer needs to see which is which.
      attribution_certain:
        state.attribution === 'portal_send' || state.attribution === 'corrected',
    })
  }

  if (rows.length > 0) {
    // One row per conversation per day, however many times the job runs.
    await supabase.from('reply_misses').upsert(rows, { onConflict: 'miss_date,room_id' })
  }

  return { date, examined, recorded: rows.length }
}

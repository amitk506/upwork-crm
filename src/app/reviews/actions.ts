'use server'

import { revalidatePath } from 'next/cache'

import { requireCapability } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { createClient } from '@/lib/supabase/server'

/**
 * Confirm or dismiss an end-of-day miss.
 *
 * Confirming is what makes it real: only confirmed misses are eligible to reach
 * the HR system. Nothing is written to a person's record automatically, because
 * most attributions are the portal's own guess about who spoke last.
 */
export async function reviewMiss(
  id: number,
  status: 'confirmed' | 'dismissed',
  note: string,
) {
  const user = await requireCapability('inbox:assign')
  const supabase = await createClient()

  const { error } = await supabase
    .from('reply_misses')
    .update({
      status,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note.trim() || null,
    })
    .eq('id', id)

  if (error) return { error: error.message }

  await logActivity({
    actorId: user.id,
    action: status === 'confirmed' ? 'review.miss_confirmed' : 'review.miss_dismissed',
    payload: { missId: id },
  })

  revalidatePath('/reviews')
  return { ok: true }
}

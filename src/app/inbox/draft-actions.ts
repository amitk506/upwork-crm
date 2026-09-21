'use server'

import { createHash } from 'node:crypto'

import { revalidatePath } from 'next/cache'

import { requireCapability, requireUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { createAdminClient } from '@/lib/supabase/admin'
import { countedWaitSeconds, waitLevel } from '@/lib/wait'
import { loadProfile, resolveActingProfile } from '@/lib/upwork/profiles'
import { mcpTransport } from '@/lib/upwork/transport-mcp'
import { MESSAGE_MAX_LENGTH, UpworkPolicyError } from '@/lib/upwork/types'

/**
 * Drafting a reply for someone else's Upwork profile to send.
 *
 * The author writes it; the profile owner approves; the message goes out from
 * the OWNER's account, under the owner's name. The client sees the person they
 * contracted with, and the owner is genuinely the sender — which is what keeps
 * this distinct from operating someone else's account.
 */

function friendly(err: unknown): string {
  if (err instanceof UpworkPolicyError) return err.message
  return err instanceof Error ? err.message : 'Something went wrong talking to Upwork'
}

export async function createDraft(input: {
  roomId: string
  ownerId: string
  body: string
  note?: string
}) {
  const user = await requireCapability('inbox:send')

  const body = input.body.trim()
  if (!body) return { error: 'Nothing to send' }
  if (body.length > MESSAGE_MAX_LENGTH) {
    return {
      error: `That is ${body.length.toLocaleString()} characters; Upwork's limit is ${MESSAGE_MAX_LENGTH.toLocaleString()}.`,
    }
  }

  const supabase = createAdminClient()

  // The approver must genuinely be able to send there, or the draft can never
  // be delivered and we would be queueing something into a dead end.
  // Resolved through the grant model — room_access was retired by migration 0011.
  const approverAccess = await resolveActingProfile(input.ownerId, input.roomId)

  if (!approverAccess?.canSend) {
    return {
      error:
        'That teammate cannot send in this conversation, so the draft could never be ' +
        'delivered. Pick someone listed as able to reply here.',
    }
  }

  const { error } = await supabase.from('outbound_drafts').insert({
    room_id: input.roomId,
    author_id: user.id,
    owner_id: input.ownerId,
    body,
    note: input.note?.trim() || null,
  })

  if (error) return { error: error.message }

  await logActivity({
    actorId: user.id,
    action: 'draft.created',
    targetType: 'room',
    targetId: input.roomId,
    payload: { ownerId: input.ownerId },
  })

  revalidatePath(`/inbox/${input.roomId}`)
  revalidatePath('/approvals')
  return { ok: true }
}

/**
 * Approve and send. Runs with the APPROVER's own Upwork token — only the person
 * who owns that profile can trigger this, and only for drafts addressed to them.
 */
export async function approveDraft(draftId: string) {
  const user = await requireUser()
  const supabase = createAdminClient()

  const { data: draft } = await supabase
    .from('outbound_drafts')
    .select('*')
    .eq('id', draftId)
    .maybeSingle()

  if (!draft) return { error: 'That draft no longer exists' }
  if (draft.status !== 'pending') return { error: `That draft was already ${draft.status}` }

  // Only the addressed profile owner may approve. Not a manager, not an owner —
  // the whole point is that the person whose name goes on the message decides.
  if (draft.owner_id !== user.id) {
    return { error: 'Only the teammate this draft is addressed to can send it from their profile' }
  }

  try {
    // Sends through the profile THIS approver holds for the room — under central
    // profiles they have no personal Upwork connection of their own.
    const acting = await resolveActingProfile(user.id, draft.room_id)
    if (!acting?.canSend) {
      return { error: 'You can no longer send in this conversation, so this draft cannot go out.' }
    }

    const profile = await loadProfile(acting.profileId)
    const waited = await measureReplyWait(draft.room_id)

    await mcpTransport.sendMessage(profile, draft.room_id, draft.body)

    await supabase
      .from('outbound_drafts')
      .update({
        status: 'approved',
        decided_by: user.id,
        decided_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        error: null,
      })
      .eq('id', draftId)

    // Attribution records BOTH people: the client sees the owner, but internally
    // the trail must show who actually wrote it.
    await supabase.from('sent_messages').upsert(
      {
        room_id: draft.room_id,
        author_id: draft.author_id,
        body_sha: createHash('sha256').update(draft.body.trim()).digest('hex'),
      },
      { onConflict: 'room_id,body_sha' },
    )

    await logActivity({
      actorId: user.id,
      action: 'inbox.replied',
      targetType: 'room',
      targetId: draft.room_id,
      payload: {
        draftId,
        // Both people matter: one wrote it, the other's profile sent it.
        writtenBy: draft.author_id,
        sentBy: user.id,
        viaApproval: true,
        // Same measurement as a direct send, so approved replies are not
        // silently missing from reply-time figures.
        ...waited,
      },
      succeeded: true,
    })

    revalidatePath(`/inbox/${draft.room_id}`)
    revalidatePath('/approvals')
    return { ok: true }
  } catch (err) {
    const message = friendly(err)

    await supabase.from('outbound_drafts').update({ error: message }).eq('id', draftId)
    await logActivity({
      actorId: user.id,
      action: 'draft.send_failed',
      targetType: 'room',
      targetId: draft.room_id,
      payload: { draftId },
      succeeded: false,
      error: message,
    })

    // Stays pending so it can be retried rather than silently lost.
    return { error: message }
  }
}

export async function declineDraft(draftId: string, reason?: string) {
  const user = await requireUser()
  const supabase = createAdminClient()

  const { data: draft } = await supabase
    .from('outbound_drafts')
    .select('id, owner_id, room_id, status')
    .eq('id', draftId)
    .maybeSingle()

  if (!draft) return { error: 'That draft no longer exists' }
  if (draft.owner_id !== user.id) return { error: 'Only the addressed teammate can decline it' }
  if (draft.status !== 'pending') return { error: `That draft was already ${draft.status}` }

  await supabase
    .from('outbound_drafts')
    .update({
      status: 'declined',
      decline_reason: reason?.trim() || null,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
    })
    .eq('id', draftId)

  await logActivity({
    actorId: user.id,
    action: 'draft.declined',
    targetType: 'room',
    targetId: draft.room_id,
    payload: { draftId, reason },
  })

  revalidatePath(`/inbox/${draft.room_id}`)
  revalidatePath('/approvals')
  return { ok: true }
}

export async function withdrawDraft(draftId: string) {
  const user = await requireUser()
  const supabase = createAdminClient()

  const { data: draft } = await supabase
    .from('outbound_drafts')
    .select('id, author_id, room_id, status')
    .eq('id', draftId)
    .maybeSingle()

  if (!draft) return { error: 'That draft no longer exists' }
  if (draft.author_id !== user.id) return { error: 'Only the author can withdraw a draft' }
  if (draft.status !== 'pending') return { error: `That draft was already ${draft.status}` }

  await supabase.from('outbound_drafts').update({ status: 'withdrawn' }).eq('id', draftId)

  revalidatePath(`/inbox/${draft.room_id}`)
  revalidatePath('/approvals')
  return { ok: true }
}


/** See measureWait() in ./actions — same reasoning, shared shape. */
async function measureReplyWait(
  roomId: string,
): Promise<{ waitedSeconds?: number; waitLevel?: string }> {
  try {
    const { data } = await createAdminClient()
      .from('room_reply_state')
      .select('awaiting_since')
      .eq('room_id', roomId)
      .maybeSingle()

    if (!data?.awaiting_since) return {}

    const seconds = countedWaitSeconds(data.awaiting_since)
    return { waitedSeconds: seconds, waitLevel: waitLevel(seconds) }
  } catch {
    return {}
  }
}

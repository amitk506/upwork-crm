'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'

import { requireCapability } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { createAdminClient } from '@/lib/supabase/admin'
import { open, safeEqual, seal, randomToken } from '@/lib/crypto'
import { buildAuthorizeUrl, createPkcePair, exchangeCode } from '@/lib/upwork/oauth'
import { saveProfile, disconnectProfile } from '@/lib/upwork/profiles'
import { callTool } from '@/lib/upwork/mcp-client'

/**
 * Connecting the agency's Upwork profiles into the portal.
 *
 * Each profile is authorized by whoever holds that Upwork account — OAuth has
 * no other way in — but the resulting connection belongs to the PORTAL, so the
 * owner can grant it onward to whoever handles that work.
 */

const PROFILE_OAUTH_COOKIE = 'upwork_profile_oauth'

type SealedCookie = { ciphertext: string; iv: string; tag: string }
type ProfileContext = 'agency' | 'freelancer'
type FlowState = {
  state: string
  verifier: string
  startedBy: string
  label: string
  context: ProfileContext
}

export async function beginProfileConnect(label: string, context: ProfileContext = 'agency') {
  const user = await requireCapability('team:manage')

  const trimmed = label.trim()
  if (!trimmed) return { error: 'Give the profile a name so the team can tell them apart' }

  const state = randomToken(16)
  const { verifier, challenge } = createPkcePair()

  const sealed = seal(
    JSON.stringify({
      state,
      verifier,
      startedBy: user.id,
      label: trimmed,
      context,
    } satisfies FlowState),
  )
  const cookieStore = await cookies()

  cookieStore.set(PROFILE_OAUTH_COOKIE, JSON.stringify(sealed), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 1800,
  })

  try {
    return { authorizeUrl: await buildAuthorizeUrl({ state, challenge }) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not build the consent URL' }
  }
}

export async function completeProfileConnect(pasted: string) {
  const user = await requireCapability('team:manage')
  const cookieStore = await cookies()

  const raw = cookieStore.get(PROFILE_OAUTH_COOKIE)?.value
  if (!raw) return { error: 'That attempt expired. Start again.' }

  let stored: FlowState
  try {
    stored = JSON.parse(open(JSON.parse(raw) as SealedCookie)) as FlowState
  } catch {
    return { error: 'The attempt could not be verified. Start again.' }
  }

  const { code, state, error: upworkError } = parsePasted(pasted)
  if (upworkError) return { error: `Upwork refused the authorization: ${upworkError}` }
  if (!code) {
    return {
      error:
        'No authorization code found. Paste the whole address bar from the page you landed on.',
    }
  }
  if (state && !safeEqual(stored.state, state)) {
    return { error: 'State mismatch — refusing to complete the connection.' }
  }

  cookieStore.delete(PROFILE_OAUTH_COOKIE)

  try {
    const tokens = await exchangeCode(code, stored.verifier)

    const accounts = await callTool<{
      accounts?: { name?: string; org_uid?: string; role?: string }[]
    }>(
      {
        userId: 'pending-profile',
        upworkUserId: '',
        orgUid: '',
        accessToken: tokens.access_token,
      },
      'list_accounts',
      'list',
    )

    const list = accounts.accounts ?? []

    // Which Upwork identity to store. Everyone in the agency shares ONE agency
    // org, so connecting several people as "agency" would collapse them into a
    // single profile. Their individual freelancer orgs are what make 7–8
    // distinct profiles possible.
    const chosen =
      stored.context === 'freelancer'
        ? (list.find((a) => a.role === 'TALENT') ?? list[0])
        : (list.find((a) => a.role === 'FL_AGENCY') ?? list[0])

    if (!chosen?.org_uid) {
      return {
        error:
          stored.context === 'freelancer'
            ? 'That login has no personal freelancer profile — try connecting it as the agency.'
            : 'Upwork returned no accounts for that login.',
      }
    }

    const profileId = await saveProfile({
      label: stored.label,
      upworkUserName: chosen.name ?? null,
      upworkUserId: chosen.org_uid,
      orgUid: chosen.org_uid,
      orgName: chosen.name ?? null,
      orgRole: chosen.role ?? null,
      connectedBy: user.id,
      tokens,
    })

    await logActivity({
      actorId: user.id,
      action: 'profile.connected',
      targetType: 'profile',
      targetId: profileId,
      payload: { label: stored.label, orgUid: chosen.org_uid },
    })

    revalidatePath('/profiles')
    return { ok: true, label: stored.label, accountName: chosen.name ?? null }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed'
    await logActivity({
      actorId: user.id,
      action: 'profile.connect_failed',
      succeeded: false,
      error: message,
    })
    return { error: message }
  }
}

export async function grantProfile(profileId: string, userId: string, canSend: boolean) {
  const actor = await requireCapability('team:manage')
  const supabase = createAdminClient()

  const { error } = await supabase
    .from('profile_grants')
    .upsert(
      { profile_id: profileId, user_id: userId, can_send: canSend, granted_by: actor.id },
      { onConflict: 'profile_id,user_id' },
    )

  if (error) return { error: error.message }

  await logActivity({
    actorId: actor.id,
    action: 'profile.granted',
    targetType: 'profile',
    targetId: profileId,
    payload: { userId, canSend },
  })

  revalidatePath('/profiles')
  return { ok: true }
}

export async function revokeProfileGrant(profileId: string, userId: string) {
  const actor = await requireCapability('team:manage')

  await createAdminClient()
    .from('profile_grants')
    .delete()
    .eq('profile_id', profileId)
    .eq('user_id', userId)

  await logActivity({
    actorId: actor.id,
    action: 'profile.grant_revoked',
    targetType: 'profile',
    targetId: profileId,
    payload: { userId },
  })

  revalidatePath('/profiles')
  return { ok: true }
}

/** Grant one specific conversation, for members who handle individual chats. */
export async function grantRoom(roomId: string, userId: string, profileId: string, canSend: boolean) {
  const actor = await requireCapability('inbox:assign')

  const { error } = await createAdminClient()
    .from('room_grants')
    .upsert(
      {
        room_id: roomId,
        user_id: userId,
        profile_id: profileId,
        can_send: canSend,
        granted_by: actor.id,
      },
      { onConflict: 'room_id,user_id' },
    )

  if (error) return { error: error.message }

  await logActivity({
    actorId: actor.id,
    action: 'room.granted',
    targetType: 'room',
    targetId: roomId,
    payload: { userId, profileId, canSend },
  })

  revalidatePath(`/inbox/${roomId}`)
  revalidatePath('/inbox')
  return { ok: true }
}

/**
 * Whether replies through this profile need the profile holder to approve.
 *
 * Leaving this ON keeps the account holder as the actual sender. Turning it OFF
 * lets granted members send under the profile directly — which Upwork's
 * account-sharing rule does not permit, so the change is audited explicitly.
 */
export async function setProfileApproval(profileId: string, required: boolean) {
  const actor = await requireCapability('roles:manage')

  const { error } = await createAdminClient()
    .from('upwork_profiles')
    .update({ send_requires_approval: required })
    .eq('id', profileId)

  if (error) return { error: error.message }

  await logActivity({
    actorId: actor.id,
    action: required ? 'profile.approval_enabled' : 'profile.approval_disabled',
    targetType: 'profile',
    targetId: profileId,
    payload: { sendRequiresApproval: required },
  })

  revalidatePath('/profiles')
  return { ok: true }
}

export async function removeProfile(profileId: string) {
  const actor = await requireCapability('roles:manage')
  await disconnectProfile(profileId)

  await logActivity({
    actorId: actor.id,
    action: 'profile.removed',
    targetType: 'profile',
    targetId: profileId,
  })

  revalidatePath('/profiles')
  return { ok: true }
}

function parsePasted(input: string): { code?: string; state?: string; error?: string } {
  const trimmed = input.trim()
  if (!trimmed) return {}

  const queryStart = trimmed.indexOf('?')
  if (queryStart !== -1) {
    const params = new URLSearchParams(trimmed.slice(queryStart + 1))
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
      error: params.get('error_description') ?? params.get('error') ?? undefined,
    }
  }
  if (!/\s/.test(trimmed)) return { code: trimmed }
  return {}
}

/** Remove a per-conversation grant. */
export async function revokeRoomGrant(roomId: string, userId: string) {
  const actor = await requireCapability('inbox:assign')

  await createAdminClient()
    .from('room_grants')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', userId)

  await logActivity({
    actorId: actor.id,
    action: 'room.grant_revoked',
    targetType: 'room',
    targetId: roomId,
    payload: { userId },
  })

  revalidatePath(`/inbox/${roomId}`)
  revalidatePath('/inbox')
  return { ok: true }
}

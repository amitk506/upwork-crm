import 'server-only'

import { createAdminClient, describeDbError } from '@/lib/supabase/admin'
import { open, seal } from '@/lib/crypto'
import { SELF_IMPOSED } from './limits'
import { refreshAccessToken, revokeToken, type TokenResponse } from './oauth'
import { UpworkPolicyError, type ConnectedUser } from './types'
import { formatTime } from '@/lib/format'

/**
 * Portal-owned Upwork profiles.
 *
 * The agency runs several Upwork profiles; the portal holds them all and grants
 * members access to the ones (or the individual chats) they handle. A member
 * never authenticates to Upwork themselves.
 *
 * Everything here uses the service-role client: upwork_profiles holds token
 * ciphertext and grants no RLS policies at all, so it is unreachable from the
 * browser by construction.
 */

const REFRESH_INTERVAL_DAYS = 7

type StoredProfile = {
  id: string
  label: string
  upwork_user_id: string | null
  org_uid: string
  send_requires_approval: boolean
  access_token_ct: string
  access_token_iv: string
  access_token_tag: string
  refresh_token_ct: string
  refresh_token_iv: string
  refresh_token_tag: string
  access_token_expires_at: string | null
  revoked_at: string | null
  circuit_open_until: string | null
}

export type ActingProfile = ConnectedUser & {
  profileId: string
  label: string
  sendRequiresApproval: boolean
}

function sealTokens(tokens: TokenResponse) {
  const access = seal(tokens.access_token)
  const refresh = seal(tokens.refresh_token)
  return {
    access_token_ct: access.ciphertext,
    access_token_iv: access.iv,
    access_token_tag: access.tag,
    refresh_token_ct: refresh.ciphertext,
    refresh_token_iv: refresh.iv,
    refresh_token_tag: refresh.tag,
    key_version: access.keyVersion,
    access_token_expires_at: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
    refresh_after: new Date(Date.now() + REFRESH_INTERVAL_DAYS * 86_400_000).toISOString(),
    refreshed_at: new Date().toISOString(),
    connect_error: null,
    revoked_at: null,
    consecutive_failures: 0,
    circuit_open_until: null,
  }
}

export async function saveProfile(params: {
  label: string
  upworkUserName: string | null
  upworkUserId: string | null
  orgUid: string
  orgName: string | null
  orgRole: string | null
  connectedBy: string
  tokens: TokenResponse
}) {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('upwork_profiles')
    .upsert(
      {
        label: params.label,
        upwork_user_name: params.upworkUserName,
        upwork_user_id: params.upworkUserId,
        org_uid: params.orgUid,
        org_name: params.orgName,
        org_role: params.orgRole,
        connected_by: params.connectedBy,
        ...sealTokens(params.tokens),
      },
      { onConflict: 'org_uid,upwork_user_id' },
    )
    .select('id')
    .single()

  if (error) throw new Error(`Could not store the profile: ${describeDbError(error)}`)

  const profileId = String((data as { id: string }).id)

  // Whoever connected it can use it immediately.
  await supabase.from('profile_grants').upsert(
    {
      profile_id: profileId,
      user_id: params.connectedBy,
      can_send: true,
      granted_by: params.connectedBy,
    },
    { onConflict: 'profile_id,user_id' },
  )

  return profileId
}

/** Load a profile ready to act with, refreshing its token if needed. */
export async function loadProfile(profileId: string): Promise<ActingProfile> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('upwork_profiles')
    .select('*')
    .eq('id', profileId)
    .maybeSingle()

  if (error) throw new Error(`Could not read the profile: ${describeDbError(error)}`)

  const row = data as StoredProfile | null
  if (!row || row.revoked_at) {
    throw new UpworkPolicyError('That Upwork profile is not connected.', 'not_connected')
  }

  if (row.circuit_open_until && new Date(row.circuit_open_until) > new Date()) {
    throw new UpworkPolicyError(
      `${row.label} is paused until ${formatTime(row.circuit_open_until)} ` +
        `after repeated errors from Upwork.`,
      'circuit_open',
    )
  }

  let accessToken = open({
    ciphertext: row.access_token_ct,
    iv: row.access_token_iv,
    tag: row.access_token_tag,
  })

  const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at) : null
  if (expiresAt && expiresAt.getTime() - Date.now() < 60_000) {
    accessToken = await refreshProfile(row)
  }

  return {
    profileId: row.id,
    label: row.label,
    sendRequiresApproval: row.send_requires_approval,
    // userId carries the PROFILE id here: rate limiting and the circuit breaker
    // are per Upwork identity, which is what Upwork actually throttles.
    userId: row.id,
    upworkUserId: row.upwork_user_id ?? '',
    orgUid: row.org_uid,
    accessToken,
  }
}

async function refreshProfile(row: StoredProfile): Promise<string> {
  const supabase = createAdminClient()

  const refreshToken = open({
    ciphertext: row.refresh_token_ct,
    iv: row.refresh_token_iv,
    tag: row.refresh_token_tag,
  })

  try {
    const tokens = await refreshAccessToken(refreshToken)
    await supabase.from('upwork_profiles').update(sealTokens(tokens)).eq('id', row.id)
    return tokens.access_token
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('upwork_profiles')
      .update({ connect_error: `Token refresh failed: ${message}` })
      .eq('id', row.id)
    throw new UpworkPolicyError(
      `${row.label} needs reconnecting — its Upwork authorization expired.`,
      'not_connected',
    )
  }
}

/** Every profile the portal holds, for sync and admin. */
export async function allActiveProfiles() {
  const { data } = await createAdminClient()
    .from('upwork_profiles')
    .select('id, label')
    .is('revoked_at', null)

  return (data ?? []) as { id: string; label: string }[]
}

/**
 * Which profile should this user act through in this room?
 *
 * Returns null when they have no grant covering it. A user may hold several
 * grants for one room (e.g. the whole profile plus a specific chat); the first
 * that permits sending wins, otherwise the first read-only one.
 */
export async function resolveActingProfile(
  userId: string,
  roomId: string,
): Promise<{ profileId: string; canSend: boolean } | null> {
  const { data } = await createAdminClient().rpc('profiles_for_room', {
    p_room_id: roomId,
    p_user_id: userId,
  })

  const rows = (data ?? []) as { profile_id: string; can_send: boolean }[]
  if (rows.length === 0) return null

  const sender = rows.find((r) => r.can_send)
  const chosen = sender ?? rows[0]
  return { profileId: chosen.profile_id, canSend: Boolean(sender) }
}

export async function recordProfileOutcome(profileId: string, ok: boolean) {
  const supabase = createAdminClient()

  if (ok) {
    await supabase
      .from('upwork_profiles')
      .update({
        consecutive_failures: 0,
        circuit_open_until: null,
        last_used_at: new Date().toISOString(),
      })
      .eq('id', profileId)
    return
  }

  const { data } = await supabase
    .from('upwork_profiles')
    .select('consecutive_failures')
    .eq('id', profileId)
    .maybeSingle()

  const failures = ((data as { consecutive_failures: number } | null)?.consecutive_failures ?? 0) + 1

  await supabase
    .from('upwork_profiles')
    .update({
      consecutive_failures: failures,
      circuit_open_until:
        failures >= SELF_IMPOSED.circuitBreakerThreshold
          ? new Date(Date.now() + SELF_IMPOSED.circuitBreakerCooldownMs).toISOString()
          : null,
    })
    .eq('id', profileId)
}

export async function disconnectProfile(profileId: string) {
  const supabase = createAdminClient()

  const { data } = await supabase
    .from('upwork_profiles')
    .select('refresh_token_ct, refresh_token_iv, refresh_token_tag')
    .eq('id', profileId)
    .maybeSingle()

  if (data) {
    const row = data as Pick<
      StoredProfile,
      'refresh_token_ct' | 'refresh_token_iv' | 'refresh_token_tag'
    >
    await revokeToken(
      open({
        ciphertext: row.refresh_token_ct,
        iv: row.refresh_token_iv,
        tag: row.refresh_token_tag,
      }),
    )
  }

  await supabase.from('upwork_profiles').delete().eq('id', profileId)
}

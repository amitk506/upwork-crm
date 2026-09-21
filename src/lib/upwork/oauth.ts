import 'server-only'

import { createHash } from 'node:crypto'

import { serverEnv } from '@/lib/env'
import { randomToken } from '@/lib/crypto'

/**
 * Upwork OAuth 2.0, authorization-code + PKCE.
 *
 * Endpoints are taken from the MCP server's published metadata at
 * https://mcp.upwork.com/.well-known/oauth-authorization-server rather than
 * hardcoded from documentation, so a change on Upwork's side surfaces as a
 * fetch failure instead of a silent mismatch.
 *
 * Each team member runs this flow with THEIR OWN Upwork account. There is no
 * shared token anywhere in this system — Upwork prohibits account sharing, and
 * per-person grants are what make the audit trail meaningful.
 */

const AUTH_SERVER_METADATA = 'https://mcp.upwork.com/.well-known/oauth-authorization-server'
export const MCP_RESOURCE = 'https://mcp.upwork.com/mcp'

type AuthServerMetadata = {
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
}

let metadataCache: { value: AuthServerMetadata; at: number } | null = null
const METADATA_TTL_MS = 60 * 60_000

export async function authServerMetadata(): Promise<AuthServerMetadata> {
  if (metadataCache && Date.now() - metadataCache.at < METADATA_TTL_MS) {
    return metadataCache.value
  }

  const response = await fetch(AUTH_SERVER_METADATA, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Could not read Upwork OAuth metadata (HTTP ${response.status})`)
  }

  const value = (await response.json()) as AuthServerMetadata
  if (!value.authorization_endpoint || !value.token_endpoint) {
    throw new Error('Upwork OAuth metadata is missing required endpoints')
  }

  metadataCache = { value, at: Date.now() }
  return value
}

/**
 * The redirect URI registered with Upwork.
 *
 * NOT derived from the portal's own URL. Upwork's dynamic client registration
 * allowlists redirect hosts — loopback and a few known vendors only — so a
 * self-hosted portal must register a LOOPBACK address and have the user paste
 * the resulting code back. Deriving this from NEXT_PUBLIC_APP_URL would send a
 * redirect_uri that was never registered, and Upwork rejects the authorize
 * request outright.
 *
 * Both the authorize request and the token exchange must send exactly this.
 */
export function redirectUri(): string {
  return serverEnv().UPWORK_REDIRECT_URI
}

export type PkcePair = { verifier: string; challenge: string }

export function createPkcePair(): PkcePair {
  const verifier = randomToken(32)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export async function buildAuthorizeUrl(params: {
  state: string
  challenge: string
}): Promise<string> {
  const metadata = await authServerMetadata()

  if (!(metadata.code_challenge_methods_supported ?? []).includes('S256')) {
    throw new Error('Upwork no longer advertises PKCE S256 — refusing to start a weaker flow')
  }

  const url = new URL(metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', requireClientId())
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.challenge)
  url.searchParams.set('code_challenge_method', 'S256')

  // RFC 8707 resource indicator, required by the MCP authorization spec.
  url.searchParams.set('resource', MCP_RESOURCE)

  // Deliberately no `scope`: Upwork advertises no scopes_supported, and
  // inventing values risks a rejected or over-broad grant.

  return url.toString()
}

export type TokenResponse = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in?: number
  scope?: string
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const metadata = await authServerMetadata()

  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  })

  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Upwork token endpoint returned non-JSON (HTTP ${response.status})`)
  }

  if (!response.ok) {
    const err = parsed as { error?: string; error_description?: string }
    throw new Error(
      `Upwork token exchange failed (HTTP ${response.status}): ` +
        `${err.error ?? 'unknown'}${err.error_description ? ` — ${err.error_description}` : ''}`,
    )
  }

  const token = parsed as TokenResponse
  if (!token.access_token || !token.refresh_token) {
    throw new Error('Upwork token response was missing access_token or refresh_token')
  }
  return token
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: requireClientId(),
      code_verifier: verifier,
      resource: MCP_RESOURCE,
      ...clientSecretParam(),
    }),
  )
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: requireClientId(),
      resource: MCP_RESOURCE,
      ...clientSecretParam(),
    }),
  )
}

/** Best effort — a failed revoke should not block disconnecting locally. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const metadata = await authServerMetadata()
    if (!metadata.revocation_endpoint) return false

    const response = await fetch(metadata.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        client_id: requireClientId(),
        ...clientSecretParam(),
      }),
      cache: 'no-store',
    })
    return response.ok
  } catch (err) {
    console.error('[upwork] token revocation failed', err)
    return false
  }
}

function requireClientId(): string {
  const id = serverEnv().UPWORK_CLIENT_ID
  if (!id) {
    throw new Error(
      'UPWORK_CLIENT_ID is not set. Run: node scripts/register-oauth-client.mjs <redirect_uri>',
    )
  }
  return id
}

/** Our DCR client authenticates with `none`, but honour a secret if one exists. */
function clientSecretParam(): Record<string, string> {
  const secret = serverEnv().UPWORK_CLIENT_SECRET
  return secret ? { client_secret: secret } : {}
}

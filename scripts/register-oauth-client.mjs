#!/usr/bin/env node
/**
 * Register an OAuth client with Upwork via RFC 7591 Dynamic Client Registration.
 *
 *   node scripts/register-oauth-client.mjs https://portal.example.com/api/upwork/callback
 *
 * LOCAL DEVELOPMENT ONLY.
 *
 * Upwork's DCR endpoint allowlists the redirect URI HOST. Loopback addresses
 * (localhost / 127.0.0.1, any port) and a fixed set of known MCP vendor hosts
 * are accepted; every other host returns 400 invalid_redirect_uri — including
 * your own domain. Even `sub.claude.ai` fails while `claude.ai` passes, so the
 * match is exact.
 *
 * A HOSTED portal therefore needs an approved Upwork API key, whose callback
 * URL you set in the API Center. See docs/01-research-findings.md §5.
 *
 * IMPORTANT: registrations cannot be deleted. DELETE on the returned
 * registration_client_uri responds 405. Register deliberately, once per
 * environment — not in a loop, not from a test suite.
 */

const REGISTRATION_ENDPOINT = 'https://www.upwork.com/register'
const METADATA_URL = 'https://mcp.upwork.com/.well-known/oauth-authorization-server'

const redirectUris = process.argv.slice(2)

if (redirectUris.length === 0) {
  console.error('Usage: node scripts/register-oauth-client.mjs <redirect_uri> [more_uris...]')
  console.error('Example: node scripts/register-oauth-client.mjs http://localhost:3000/api/upwork/callback')
  process.exit(1)
}

const invalid = redirectUris.filter((u) => {
  try {
    const url = new URL(u)
    return url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1'
  } catch {
    return true
  }
})

if (invalid.length > 0) {
  console.error('These redirect URIs are not valid (need https, or localhost for dev):')
  for (const u of invalid) console.error(`  ${u}`)
  process.exit(1)
}

console.log('Authorization server metadata:')
const metadata = await fetch(METADATA_URL).then((r) => r.json())
console.log(`  authorize : ${metadata.authorization_endpoint}`)
console.log(`  token     : ${metadata.token_endpoint}`)
console.log(`  revoke    : ${metadata.revocation_endpoint}`)
console.log(`  pkce      : ${(metadata.code_challenge_methods_supported ?? []).join(', ')}`)
console.log()

console.log(`Registering client for:\n${redirectUris.map((u) => `  ${u}`).join('\n')}\n`)

const response = await fetch(REGISTRATION_ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_name: 'Agency Portal',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Public client + PKCE. The portal is a confidential server, but Upwork's
    // DCR issues no secret here, so PKCE carries the security.
    token_endpoint_auth_method: 'none',
  }),
})

const body = await response.json().catch(() => null)

if (!response.ok) {
  console.error(`Registration failed (HTTP ${response.status}):`)
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

console.log('Registered.\n')
console.log('Add to .env.local:\n')
console.log(`UPWORK_CLIENT_ID=${body.client_id}`)
if (body.client_secret) console.log(`UPWORK_CLIENT_SECRET=${body.client_secret}`)
console.log()
console.log('Keep these somewhere safe — the registration cannot be deleted or re-fetched:')
console.log(`  registration_access_token: ${body.registration_access_token}`)
console.log(`  registration_client_uri:   ${body.registration_client_uri}`)

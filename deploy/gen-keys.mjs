#!/usr/bin/env node
/**
 * Generates the secrets for a self-hosted Supabase-compatible stack.
 *
 * The anon and service_role "keys" are ordinary HS256 JWTs signed with the
 * shared JWT secret. PostgREST validates the signature and switches to the
 * Postgres role named in the `role` claim — that is the entire mechanism behind
 * "the anon key is safe to ship, the service_role key is not".
 *
 *   node deploy/gen-keys.mjs > deploy/.secrets.env
 */

import { createHmac, randomBytes } from 'node:crypto'

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function jwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${header}.${body}.${signature}`
}

const jwtSecret = randomBytes(32).toString('base64')
const issuedAt = Math.floor(Date.now() / 1000)
// Ten years: these are infrastructure credentials, not user sessions. Rotating
// them means regenerating the whole set anyway.
const expiresAt = issuedAt + 10 * 365 * 24 * 60 * 60

const anonKey = jwt({ role: 'anon', iss: 'supabase', iat: issuedAt, exp: expiresAt }, jwtSecret)
const serviceKey = jwt(
  { role: 'service_role', iss: 'supabase', iat: issuedAt, exp: expiresAt },
  jwtSecret,
)

const out = {
  POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
  AUTH_ADMIN_PASSWORD: randomBytes(24).toString('base64url'),
  AUTHENTICATOR_PASSWORD: randomBytes(24).toString('base64url'),
  JWT_SECRET: jwtSecret,
  ANON_KEY: anonKey,
  SERVICE_ROLE_KEY: serviceKey,
  // Encrypts Upwork OAuth tokens at rest, application-side.
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
}

for (const [key, value] of Object.entries(out)) {
  console.log(`${key}=${value}`)
}

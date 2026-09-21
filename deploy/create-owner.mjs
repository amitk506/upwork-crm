#!/usr/bin/env node
/**
 * Creates the first portal account. Signup is disabled in GoTrue, so there is
 * no self-serve way in — this admin path is deliberately the only door.
 *
 * The portal's on_auth_user_created trigger makes the FIRST account an owner,
 * so this needs to run before anyone else is added.
 *
 *   node create-owner.mjs you@example.com "Your Name"
 *
 * Run from /docker/upwork-portal on the VPS, where .env holds the keys.
 */

import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const [email, fullName] = process.argv.slice(2)
if (!email) {
  console.error('Usage: node create-owner.mjs <email> [full name]')
  process.exit(1)
}

const env = Object.fromEntries(
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=')
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()]
    }),
)

const base = env.PUBLIC_URL
const serviceKey = env.SERVICE_ROLE_KEY
if (!base || !serviceKey) {
  console.error('.env is missing PUBLIC_URL or SERVICE_ROLE_KEY')
  process.exit(1)
}

const password = randomBytes(18).toString('base64url')

const response = await fetch(`${base}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName ?? email.split('@')[0] },
  }),
})

const body = await response.json().catch(() => null)

if (!response.ok) {
  console.error(`Failed (HTTP ${response.status}):`)
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

console.log('Owner account created.\n')
console.log(`  email:    ${email}`)
console.log(`  password: ${password}\n`)
console.log('Shown once. Sign in and change it, then add the rest of the team from /team.')

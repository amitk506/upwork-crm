#!/usr/bin/env node
/**
 * Diagnostic: make raw MCP calls with a stored token and print exactly what
 * Upwork says. Run on the VPS from /docker/upwork-portal/deploy.
 *
 * Never prints the access token itself.
 */

import { readFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
import { execSync } from 'node:child_process'

const env = Object.fromEntries(
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const row = execSync(
  `docker exec upwork-postgres psql -U postgres -tAF'|' -c ` +
    `"select access_token_ct, access_token_iv, access_token_tag, org_uid from public.upwork_connections limit 1"`,
  { encoding: 'utf8' },
).trim()

if (!row) {
  console.error('No connection stored — the OAuth exchange did not persist a token.')
  process.exit(1)
}

const [ct, iv, tag, orgUid] = row.split('|')

const decipher = createDecipheriv(
  'aes-256-gcm',
  Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64'),
  Buffer.from(iv, 'base64'),
)
decipher.setAuthTag(Buffer.from(tag, 'base64'))
const token = Buffer.concat([
  decipher.update(Buffer.from(ct, 'base64')),
  decipher.final(),
]).toString('utf8')

console.log(`token decrypted OK (${token.length} chars), org_uid=${orgUid}\n`)

const ENDPOINT = 'https://mcp.upwork.com/mcp'
const PROTOCOL = '2025-06-18'

async function call(label, body, extraHeaders = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  console.log(`=== ${label}`)
  console.log(`    HTTP ${res.status}`)
  const session = res.headers.get('mcp-session-id')
  if (session) console.log(`    Mcp-Session-Id: ${session}`)
  console.log(`    body: ${text.slice(0, 700)}\n`)
  return { res, text, session }
}

// 1. tools/call with NO handshake — what the portal currently does
await call('tools/call WITHOUT initialize (current portal behaviour)', {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'list_accounts', arguments: { action: 'list' } },
})

// 2. proper handshake
const init = await call('initialize', {
  jsonrpc: '2.0',
  id: 2,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'agency-portal', version: '1.0.0' },
  },
})

const sessionHeader = init.session ? { 'Mcp-Session-Id': init.session } : {}

if (init.session) {
  await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      ...sessionHeader,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  console.log('=== sent notifications/initialized\n')
}

await call(
  'tools/call AFTER initialize',
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_accounts', arguments: { action: 'list' } },
  },
  sessionHeader,
)

await call(
  'tools/list AFTER initialize',
  { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
  sessionHeader,
)

#!/usr/bin/env node
/**
 * Dump the raw shape of a room's messages so the mappers can be written against
 * reality instead of inference. Run on the VPS from /docker/upwork-portal/deploy:
 *
 *   ROW=... KEY=... RID=... node dump-messages.mjs
 *
 * Never prints the access token.
 */
import { createDecipheriv } from 'node:crypto'

const [ct, iv, tag, org] = process.env.ROW.split('|')

const d = createDecipheriv(
  'aes-256-gcm',
  Buffer.from(process.env.KEY, 'base64'),
  Buffer.from(iv, 'base64'),
)
d.setAuthTag(Buffer.from(tag, 'base64'))
const token = Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString()

const E = 'https://mcp.upwork.com/mcp'
const P = '2025-06-18'
const H = (s) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': P,
  ...(s ? { 'Mcp-Session-Id': s } : {}),
})

function parse(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      try {
        return JSON.parse(line.slice(5).trim())
      } catch {}
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function call(sid, name, args) {
  const r = await fetch(E, {
    method: 'POST',
    headers: H(sid),
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  })
  const j = parse(await r.text())
  const text = j?.result?.content?.[0]?.text
  return text ? JSON.parse(text) : j
}

const init = await fetch(E, {
  method: 'POST',
  headers: H(),
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: P, capabilities: {}, clientInfo: { name: 'dump', version: '1' } },
  }),
})
const sid = init.headers.get('mcp-session-id')
await fetch(E, {
  method: 'POST',
  headers: H(sid),
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
})

console.log('===== WHO AM I (get_profile) =====')
const profile = await call(sid, 'upwork__get_profile', { action: 'get', org_uid: '664761524938571777' })
const ident = profile?.data?.identity ?? {}
console.log('personId:', profile?.data?.personId, 'identity.id:', ident.id)

console.log('\n===== MESSAGES (raw first 3) =====')
const msgs = await call(sid, 'upwork__get_messages', {
  action: 'list_messages',
  org_uid: org,
  params: { room_id: process.env.RID, limit: 3 },
})
console.log(JSON.stringify(msgs, null, 2).slice(0, 3000))

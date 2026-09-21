import 'server-only'

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

import { serverEnv } from './env'

/**
 * Token vault primitives.
 *
 * Upwork OAuth tokens are encrypted here, in the application, before they ever
 * reach Postgres. pgcrypto was deliberately rejected: passing the key as a SQL
 * parameter risks leaking it into query logs, pg_stat_statements and error
 * traces. This way Postgres never sees the key or a plaintext token.
 *
 * AES-256-GCM gives us authenticated encryption — a tampered ciphertext fails
 * to decrypt rather than silently returning garbage.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96 bits, the GCM standard

export type SealedSecret = {
  ciphertext: string
  iv: string
  tag: string
  keyVersion: number
}

function key(): Buffer {
  return Buffer.from(serverEnv().TOKEN_ENCRYPTION_KEY, 'base64')
}

export function seal(plaintext: string): SealedSecret {
  if (!plaintext) throw new Error('seal() called with an empty value')

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: 1,
  }
}

export function open(sealed: Omit<SealedSecret, 'keyVersion'>): string {
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))

  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** Constant-time compare, for OAuth `state` and similar. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** URL-safe random token, for OAuth `state` and PKCE verifiers. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

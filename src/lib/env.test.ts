import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { z } from 'zod'

/**
 * Regression tests for env parsing.
 *
 * The bug these exist to prevent: docker compose renders an unset variable as
 * `FOO=`, i.e. a present EMPTY STRING. `z.string().min(1).optional()` accepts
 * undefined but rejects "", so every page that touched serverEnv() threw a
 * ZodError in production while working fine locally.
 */

function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional())
}

test('empty string is treated as absent, not as a too-short string', () => {
  const schema = z.object({ FOO: emptyToUndefined(z.string().min(1)) })

  // zod omits the key entirely rather than setting it to undefined, so compare
  // the property rather than deep-equalling the object.
  assert.equal(schema.parse({ FOO: '' }).FOO, undefined)
  assert.equal(schema.parse({}).FOO, undefined)
  assert.equal(schema.parse({ FOO: 'value' }).FOO, 'value')
})

test('the naive schema is what broke — kept so the difference stays visible', () => {
  const naive = z.object({ FOO: z.string().min(1).optional() })

  assert.equal(naive.safeParse({ FOO: '' }).success, false)
  assert.equal(naive.safeParse({}).success, true)
})

test('an empty URL variable falls back to its default', () => {
  const schema = z.object({
    REDIRECT: emptyToUndefined(z.url()).pipe(z.string().default('http://localhost:3000/cb')),
  })

  assert.equal(schema.parse({ REDIRECT: '' }).REDIRECT, 'http://localhost:3000/cb')
  assert.equal(schema.parse({}).REDIRECT, 'http://localhost:3000/cb')
  assert.equal(
    schema.parse({ REDIRECT: 'https://example.com/cb' }).REDIRECT,
    'https://example.com/cb',
  )
})

test('a malformed URL is still rejected rather than silently defaulted', () => {
  const schema = z.object({
    REDIRECT: emptyToUndefined(z.url()).pipe(z.string().default('http://localhost:3000/cb')),
  })

  assert.equal(schema.safeParse({ REDIRECT: 'not-a-url' }).success, false)
})

test('every field in the server schema is actually read from process.env', () => {
  // serverEnv() parses an EXPLICIT object rather than process.env wholesale, so a
  // field added to the schema but not to that object silently resolves to
  // undefined for ever. That is what happened to STATUS_BOARD_TOKEN: the variable
  // was set in the container, matched the URL, and the page still 404'd.
  const source = readFileSync(new URL('./env.ts', import.meta.url), 'utf8')

  // Bounded at the next top-level declaration: clientSchema sits between
  // serverSchema and serverEnv(), and its NEXT_PUBLIC_ fields are read by
  // clientEnv() instead — pulling them in here would fail for the wrong reason.
  const schemaStart = source.indexOf('const serverSchema')
  const schemaBlock = source.slice(schemaStart, source.indexOf('export const clientEnv'))
  const parseBlock = source.slice(source.indexOf('cachedServerEnv = serverSchema.parse({'))

  const declared = [...schemaBlock.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!)
  assert.ok(declared.length > 3, 'expected to find the schema fields')

  const missing = declared.filter((name) => !parseBlock.includes(`${name}: process.env.${name}`))
  assert.deepEqual(missing, [], `these are declared but never read: ${missing.join(', ')}`)
})

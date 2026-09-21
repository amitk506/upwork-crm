import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  cleanMessageText,
  decodeEntities,
  isSystemEvent,
  isUpworkPlaceholder,
  renderMentions,
} from './text.ts'

/** Every case below is taken from a real payload seen in the live inbox. */

test('decodes HTML entities Upwork returns escaped', () => {
  // Rendered literally as "&amp;" in the thread before this fix.
  assert.equal(
    decodeEntities("I'll find out &amp; share it with you"),
    "I'll find out & share it with you",
  )
  assert.equal(decodeEntities('a &lt;b&gt; c'), 'a <b> c')
  assert.equal(decodeEntities('&quot;quoted&quot;'), '"quoted"')
  assert.equal(decodeEntities('&#39;apos&#39;'), "'apos'")
  assert.equal(decodeEntities('&#x2014;'), '—')
})

test('leaves unknown entities alone rather than mangling them', () => {
  assert.equal(decodeEntities('100 &widget; each'), '100 &widget; each')
})

test('renders mention markup as a readable name', () => {
  assert.equal(
    renderMentions('<@1526914229386612736:1526914229386612737|Max Castiel> Also, all of these'),
    '@Max Castiel Also, all of these',
  )
  assert.equal(
    renderMentions('Hi <@424177617406902272:425230075412246528|William Kreitzmann>, have you'),
    'Hi @William Kreitzmann, have you',
  )
})

test('full pipeline strips wrappers, decodes, and renders mentions', () => {
  const raw =
    '<untrusted_participant_content>\n' +
    'Hi <@1:2|Max Castiel>, sent the docs &amp; the brief.\n' +
    '</untrusted_participant_content>'

  assert.equal(cleanMessageText(raw), 'Hi @Max Castiel, sent the docs & the brief.')
})

test('empty or whitespace-only content becomes null, not an empty bubble', () => {
  assert.equal(cleanMessageText(null), null)
  assert.equal(cleanMessageText(''), null)
  assert.equal(cleanMessageText('<untrusted_participant_content>\n\n</untrusted_participant_content>'), null)
})

test('actionVerb separates human messages from system events', () => {
  // Verified live: real messages carry 'posted'; the rest are system stories.
  assert.equal(isSystemEvent('posted'), false)
  assert.equal(isSystemEvent('invited'), true)
  assert.equal(isSystemEvent('accepted'), true)
  assert.equal(isSystemEvent('sent'), true)
  // Unknown verb — treat as a normal message rather than hiding it as a notice.
  assert.equal(isSystemEvent(null), false)
  assert.equal(isSystemEvent(undefined), false)
})

test('Upwork placeholder bodies are recognised, whatever the verb', () => {
  for (const verb of ['posted', 'created', 'sent']) {
    assert.equal(
      isUpworkPlaceholder(`System event: ${verb}. View this conversation on upwork.com for full context.`),
      true,
      verb,
    )
  }
})

test('a real message that mentions upwork.com is not a placeholder', () => {
  assert.equal(isUpworkPlaceholder('Can you check the brief on upwork.com for full context?'), false)
  assert.equal(isUpworkPlaceholder('System event handling is broken'), false)
  assert.equal(isUpworkPlaceholder(null), false)
  assert.equal(isUpworkPlaceholder(''), false)
})

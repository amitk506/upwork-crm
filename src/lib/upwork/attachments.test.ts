import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  formatBytes,
  kindLabel,
  parseAttachments,
  safeAttachmentUrl,
  unwrap,
  uploaderUserId,
} from './attachments.ts'

/** Upwork wraps every value in its prompt-injection guard, newlines and all. */
const wrapped = (v: string) => `<untrusted_participant_content>\n${v}\n</untrusted_participant_content>`

const file = (over: Record<string, string> = {}) => ({
  objectType: 'eo:file',
  objectReferenceId: 'object_reference_abc',
  metadata: Object.entries({
    fileName: 'Brochure 2026.pdf',
    fileSize: '273663',
    objectUrl: 'https://www.upwork.com/ab/messages/att/7a7ad685',
    scanStatus: 'CLEAN',
    mimeType: 'application/pdf',
    fileId: '7a7ad685',
    ...over,
  }).map(([key, value]) => ({ key: wrapped(key), value: wrapped(value) })),
})

test('the injection wrapper is stripped, not displayed', () => {
  assert.equal(unwrap(wrapped('report.pdf')), 'report.pdf')
  assert.equal(unwrap('plain'), 'plain')
  assert.equal(unwrap(wrapped('   ')), null)
  assert.equal(unwrap(undefined), null)
})

test('a real attachment parses into named fields', () => {
  const [a] = parseAttachments([file()])
  assert.equal(a!.name, 'Brochure 2026.pdf')
  assert.equal(a!.size, 273663)
  assert.equal(a!.mimeType, 'application/pdf')
  assert.equal(a!.safe, true)
  assert.equal(a!.isImage, false)
  assert.equal(a!.url, 'https://www.upwork.com/ab/messages/att/7a7ad685')
})

test('images are recognised', () => {
  const [a] = parseAttachments([file({ mimeType: 'image/png', fileName: 'shot.png' })])
  assert.equal(a!.isImage, true)
  assert.equal(kindLabel(a!), 'Image')
})

test('quoted messages are not files', () => {
  assert.deepEqual(parseAttachments([{ objectType: 'eo:quote', metadata: [] }]), [])
})

test('an unscanned or infected file is not treated as safe', () => {
  assert.equal(parseAttachments([file({ scanStatus: 'INFECTED' })])[0]!.safe, false)
  const noStatus = { ...file() }
  noStatus.metadata = noStatus.metadata.filter((m) => !m.key.includes('scanStatus'))
  assert.equal(parseAttachments([noStatus])[0]!.safe, false)
})

test('only Upwork https URLs survive', () => {
  assert.equal(safeAttachmentUrl('https://www.upwork.com/ab/messages/att/x'), 'https://www.upwork.com/ab/messages/att/x')
  // A filename and a URL both come from the sender, so the href is validated
  // rather than trusted.
  assert.equal(safeAttachmentUrl('https://evil.example.com/x'), null)
  assert.equal(safeAttachmentUrl('javascript:alert(1)'), null)
  assert.equal(safeAttachmentUrl('http://www.upwork.com/x'), null)
  assert.equal(safeAttachmentUrl(null), null)
  assert.equal(safeAttachmentUrl('not a url'), null)
})

test('a hostile URL leaves the attachment linkless but still listed', () => {
  const [a] = parseAttachments([file({ objectUrl: 'https://evil.example.com/steal' })])
  assert.equal(a!.url, null)
  assert.equal(a!.name, 'Brochure 2026.pdf')
})

test('malformed payloads never throw', () => {
  assert.deepEqual(parseAttachments(null), [])
  assert.deepEqual(parseAttachments('nope'), [])
  assert.deepEqual(parseAttachments([{ objectType: 'eo:file' }])[0]!.name, 'Attachment')
  assert.equal(parseAttachments([{ objectType: 'eo:file', metadata: 'bad' }])[0]!.size, null)
})

test('sizes read at a glance', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(273663), '267 KB')
  assert.equal(formatBytes(5_242_880), '5.0 MB')
  assert.equal(formatBytes(null), null)
})

test('WHITELISTED is a pass, not a warning', () => {
  // Upwork returns this for file types it trusts without scanning. Treating it
  // as suspect flagged 65 of 81 real attachments red and withheld their links.
  const [a] = parseAttachments([file({ scanStatus: 'WHITELISTED' })])
  assert.equal(a!.safe, true)
})

test('scan status is compared case-insensitively', () => {
  assert.equal(parseAttachments([file({ scanStatus: 'whitelisted' })])[0]!.safe, true)
  assert.equal(parseAttachments([file({ scanStatus: 'Clean' })])[0]!.safe, true)
})

test('anything else is still withheld', () => {
  for (const status of ['INFECTED', 'PENDING', 'FAILED', 'UNKNOWN']) {
    assert.equal(parseAttachments([file({ scanStatus: status })])[0]!.safe, false, status)
  }
})

test('the uploader id is read from attachment metadata', () => {
  // Upwork names no sender on a message, but from Aug 2026 it names one on a
  // file. This is the only certain attribution available without the API key.
  const withUploader = {
    ...file(),
    metadata: [
      ...file().metadata,
      { key: wrapped('userId'), value: wrapped('1638611776648732672') },
    ],
  }
  assert.equal(uploaderUserId([withUploader]), '1638611776648732672')
})

test('no uploader id is not an error', () => {
  assert.equal(uploaderUserId([file()]), null)
  assert.equal(uploaderUserId([]), null)
  assert.equal(uploaderUserId(null), null)
  assert.equal(uploaderUserId([{ objectType: 'eo:quote' }]), null)
})

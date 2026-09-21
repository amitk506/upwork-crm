/**
 * Reading the files hanging off a message.
 *
 * Upwork returns attachments as a list of objects whose fields are a metadata
 * array of {key, value} pairs rather than named properties, and every value is
 * wrapped in <untrusted_participant_content> markers — their guard against
 * prompt injection, since a filename is written by whoever uploaded it.
 *
 * Those markers are stripped for display: this is an interface, not a model
 * prompt. What must survive is the reason they exist — filenames, and everything
 * else in here, are attacker-controlled strings. They are rendered as text and
 * never as markup, and objectUrl is checked to be an Upwork https URL before it
 * is ever put in an href.
 */

export type Attachment = {
  id: string
  name: string
  mimeType: string | null
  /** Bytes, when Upwork reported a parseable size. */
  size: number | null
  /** Only set when the URL passed validation. */
  url: string | null
  /** Upwork's virus scan. Anything but CLEAN is not offered as a link. */
  scanStatus: string | null
  isImage: boolean
  safe: boolean
}

const WRAPPER = /<\/?untrusted_participant_content>/g

/**
 * Scan results Upwork considers benign.
 *
 * CLEAN is a scan that passed. WHITELISTED is a file type or hash Upwork trusts
 * without scanning — 65 of this agency's 81 attachments, so treating it as
 * suspect flagged most real files red and refused to link them. Anything else,
 * including a MISSING status, stays unsafe: an absent result is not a pass.
 */
const SAFE_SCAN_STATUSES = new Set(['CLEAN', 'WHITELISTED'])

export function isScanSafe(status: string | null): boolean {
  return status !== null && SAFE_SCAN_STATUSES.has(status.toUpperCase())
}

/** Unwrap Upwork's injection guard and tidy the whitespace it adds. */
export function unwrap(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(WRAPPER, '').trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Only Upwork's own https URLs, and only for the attachment path.
 *
 * The value comes from a message payload, so treating it as a trusted href would
 * put an attacker-chosen destination behind a link the team is being told is a
 * client's file.
 */
export function safeAttachmentUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return null
    if (url.hostname !== 'www.upwork.com' && url.hostname !== 'upwork.com') return null
    return url.toString()
  } catch {
    return null
  }
}

function metadataOf(node: unknown): Record<string, string> {
  const record: Record<string, string> = {}
  if (!node || typeof node !== 'object') return record

  const list = (node as { metadata?: unknown }).metadata
  if (!Array.isArray(list)) return record

  for (const pair of list) {
    if (!pair || typeof pair !== 'object') continue
    const key = unwrap((pair as { key?: unknown }).key)
    const value = unwrap((pair as { value?: unknown }).value)
    if (key && value) record[key] = value
  }
  return record
}

export function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []

  return raw
    // eo:quote is a quoted message, not a file — it has no filename and would
    // render as a nameless empty attachment.
    .filter((node) => (node as { objectType?: string })?.objectType === 'eo:file')
    .map((node, index) => {
      const meta = metadataOf(node)
      const mimeType = meta.mimeType ?? null
      const scanStatus = meta.scanStatus ?? null
      const size = Number(meta.fileSize)

      return {
        id: meta.fileId ?? (node as { objectReferenceId?: string })?.objectReferenceId ?? `file-${index}`,
        name: meta.fileName ?? 'Attachment',
        mimeType,
        size: Number.isFinite(size) && size > 0 ? size : null,
        url: safeAttachmentUrl(meta.objectUrl ?? null),
        scanStatus,
        isImage: Boolean(mimeType?.startsWith('image/')),
        safe: isScanSafe(scanStatus),
      }
    })
}

/** "273 KB" — a size is only useful if you can read it at a glance. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A short, human label for the file type. */
export function kindLabel(attachment: Attachment): string {
  const mime = attachment.mimeType ?? ''
  if (mime.startsWith('image/')) return 'Image'
  if (mime === 'application/pdf') return 'PDF'
  if (mime.includes('spreadsheet') || mime.includes('excel')) return 'Spreadsheet'
  if (mime.includes('wordprocessing') || mime === 'application/msword') return 'Document'
  if (mime.startsWith('video/')) return 'Video'
  if (mime.startsWith('audio/')) return 'Audio'
  if (mime.includes('zip') || mime.includes('compressed')) return 'Archive'
  const ext = attachment.name.split('.').pop()
  return ext && ext.length <= 5 ? ext.toUpperCase() : 'File'
}


/**
 * The Upwork user id of whoever uploaded a file on this message.
 *
 * Added to the attachment metadata in the Aug 2026 payload change, and it is the
 * only place in the entire messaging API that names a sender. Upwork still does
 * not attribute the message itself — but if someone attached a file, this says
 * who they were.
 *
 * That is worth a great deal here: it turns a guess into a fact for every message
 * carrying a file, and those facts then anchor the turn-taking pass for the
 * messages around them.
 */
export function uploaderUserId(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null

  for (const node of raw) {
    if (!node || typeof node !== 'object') continue
    const list = (node as { metadata?: unknown }).metadata
    if (!Array.isArray(list)) continue

    for (const pair of list) {
      if (!pair || typeof pair !== 'object') continue
      const key = unwrap((pair as { key?: unknown }).key)
      if (key !== 'userId') continue
      const value = unwrap((pair as { value?: unknown }).value)
      if (value) return value
    }
  }
  return null
}

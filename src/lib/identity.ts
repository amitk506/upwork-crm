/**
 * Identity colour.
 *
 * Every Upwork profile the portal holds gets a hue, assigned deterministically
 * from its id so it never shifts between sessions or between people's screens —
 * the team learns "Gayatri is the violet one" and that has to stay true.
 *
 * Eight hues, chosen to hold roughly equal weight against both the light and
 * dark ground, and to stay distinguishable for the most common colour vision
 * deficiencies. Colour is never the only signal: the profile's name is always
 * written next to it.
 */

const HUES = [
  { name: 'steel', light: '#2f6f8f', dark: '#6fb3d0' },
  { name: 'violet', light: '#7048b8', dark: '#b292e8' },
  { name: 'rust', light: '#a9541d', dark: '#de9560' },
  { name: 'pine', light: '#1c7558', dark: '#5ec3a2' },
  { name: 'plum', light: '#9e3a66', dark: '#e284ac' },
  { name: 'slate', light: '#46578a', dark: '#93a5d8' },
  { name: 'ochre', light: '#83671c', dark: '#cfb264' },
  { name: 'moss', light: '#3b6a3f', dark: '#84be88' },
] as const

/** Stable, order-independent: the same id always lands on the same hue. */
function hash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

export function identityHue(profileId: string | null | undefined) {
  if (!profileId) return null
  return HUES[hash(profileId) % HUES.length]!
}

/**
 * A CSS custom property the `.spine` class and chips read from.
 * `light-dark()` lets one value serve both themes without a client-side check,
 * so a server-rendered row never flashes the wrong colour.
 */
export function identityStyle(profileId: string | null | undefined) {
  const hue = identityHue(profileId)
  if (!hue) return undefined
  return { '--identity': `light-dark(${hue.light}, ${hue.dark})` } as React.CSSProperties
}

import { identityStyle } from '@/lib/identity'

/**
 * A profile's icon: its initials on a tinted tile with a 2px bar underneath in
 * that identity's colour.
 *
 * A coloured dot was too small to identify at a glance in a dense list, and a
 * solid fill made eight of them shout across a 336px column. Initials carry the
 * identification even where the colour cannot — small tiles, colour vision
 * deficiency, a printed screenshot — so the colour is reinforcement, and the
 * bar gives it enough saturation to be learnable without flooding the row.
 */

const SIZES = {
  xs: 'h-5 w-5 text-[9px] rounded-[5px]',
  sm: 'h-6 w-6 text-[10px] rounded-[6px]',
  md: 'h-[34px] w-[34px] text-[11.5px] rounded-[9px]',
  lg: 'h-[52px] w-[52px] text-[17px] rounded-[12px]',
} as const

/** "Acme Marketing Solutions" → AM · "Gayatri" → GA */
export function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

export function ProfileAvatar({
  profileId,
  label,
  size = 'sm',
}: {
  profileId: string
  label: string
  size?: keyof typeof SIZES
}) {
  return (
    <span
      style={identityStyle(profileId)}
      title={label}
      aria-hidden
      data-size={size === 'xs' || size === 'sm' ? 'sm' : 'md'}
      className={[
        'identity-tile inline-flex shrink-0 select-none items-center justify-center',
        'font-bold leading-none tracking-tight',
        SIZES[size],
      ].join(' ')}
    >
      {initials(label)}
    </span>
  )
}

import { ImageResponse } from 'next/og'

/**
 * The installed-app icon, drawn once and rendered at whatever size is asked for.
 *
 * Kept as code rather than checked-in binaries so the mark stays in step with
 * icon.svg — two files that must agree, not five.
 *
 * `padded` produces the maskable variant: Android crops icons to whatever shape
 * the launcher uses, and a mark drawn edge-to-edge loses its corners. The safe
 * zone is the middle 80%, so the padded version keeps the bubble inside that
 * circle and lets the green run to the edges.
 */
export function renderAppIcon(size: number, padded = false) {
  const bubbleWidth = Math.round(size * (padded ? 0.5 : 0.62))
  const bubbleHeight = Math.round(bubbleWidth * 0.72)
  const dot = Math.round(bubbleWidth * 0.13)

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1AA05C',
        }}
      >
        <div
          style={{
            width: bubbleWidth,
            height: bubbleHeight,
            borderRadius: Math.round(bubbleHeight * 0.3),
            background: '#FFFFFF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: dot,
          }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{ width: dot, height: dot, borderRadius: dot, background: '#1AA05C' }}
            />
          ))}
        </div>
      </div>
    ),
    { width: size, height: size },
  )
}

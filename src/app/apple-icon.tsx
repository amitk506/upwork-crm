import { ImageResponse } from 'next/og'

/**
 * The home-screen icon.
 *
 * apple-icon only accepts a raster, so this generates one rather than requiring
 * a binary in the repo — the mark stays editable as code alongside icon.svg.
 * No rounded corners here: iOS applies its own mask, and baking one in leaves a
 * dark halo inside it.
 *
 * The tail of the speech bubble is dropped at this size — at 180px it would be a
 * small notch on a large tile, and the bubble reads as a bubble without it.
 */
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
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
        {/* Same mark as icon.svg — a conversation bubble with one dot per
            identity. Kept in step by hand: two renderers, one design. */}
        <div
          style={{
            width: 118,
            height: 86,
            borderRadius: 26,
            background: '#FFFFFF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
          }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{ width: 16, height: 16, borderRadius: 8, background: '#1AA05C' }}
            />
          ))}
        </div>
      </div>
    ),
    size,
  )
}

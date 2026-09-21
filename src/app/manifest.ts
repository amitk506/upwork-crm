import type { MetadataRoute } from 'next'

/**
 * What makes this installable to a home screen.
 *
 * `display: standalone` drops the browser chrome, which is the whole point on a
 * phone: the bottom tab bar becomes the navigation and the address bar stops
 * eating a line of the conversation.
 *
 * `start_url` is the inbox rather than the root, because nobody installs this to
 * look at a landing page. Anyone not signed in still lands on /login — the proxy
 * decides that, not the manifest.
 *
 * No `screenshots` or `shortcuts`: they would be invented rather than designed,
 * and an install prompt is not improved by fictional detail.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Upwork Agency Portal',
    short_name: 'Agency',
    description: 'Client conversations across every agency profile, in one inbox.',
    start_url: '/inbox',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0C0E13',
    theme_color: '#1AA05C',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  }
}

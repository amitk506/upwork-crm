/*
 * Service worker.
 *
 * Deliberately minimal. A portal whose entire job is "what changed in the last
 * minute" must never serve a stale page from a cache — an inbox that quietly
 * shows yesterday's waits is worse than one that admits it is offline. So there
 * is no runtime caching of pages or API responses at all.
 *
 * What it does do:
 *   · satisfies the installability requirement, so the app can go on a home
 *     screen and run without browser chrome
 *   · serves one offline page when the network is genuinely gone, instead of the
 *     browser's dinosaur
 *   · takes control immediately on update, so a fixed version ships without
 *     asking people to close every tab
 */

const VERSION = 'v1'
const SHELL = `shell-${VERSION}`
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll([OFFLINE_URL, '/icon.svg'])),
  )
  // No waiting for every other tab to close before a fix takes effect.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Only page loads. Everything else — data, icons, actions — goes straight to
  // the network, because none of it is safe to answer from a cache here.
  if (request.mode !== 'navigate') return

  event.respondWith(
    fetch(request).catch(async () => {
      const cache = await caches.open(SHELL)
      return (await cache.match(OFFLINE_URL)) ?? Response.error()
    }),
  )
})

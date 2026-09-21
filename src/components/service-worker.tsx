'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker, which is what makes the portal installable.
 *
 * Registration is deferred until after load: it is not needed to render
 * anything, and competing with the first paint for bandwidth on a phone is a
 * poor trade for a background capability.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // An install failing must never break the page — the portal works
        // perfectly well as an ordinary site.
      })
    }

    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
  }, [])

  return null
}

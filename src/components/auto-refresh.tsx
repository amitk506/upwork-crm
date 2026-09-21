'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

/**
 * Keeps the page in step with what the background sync has pulled in.
 *
 * The sync container polls Upwork; this only re-reads the portal's own
 * database, so it costs nothing against the Upwork budget however many tabs
 * are open.
 *
 * Pauses when the tab is hidden. A laptop with the portal open on a spare
 * screen all day should not be re-rendering every 20 seconds for nobody.
 */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter()
  const [live, setLive] = useState(true)

  useEffect(() => {
    function onVisibility() {
      const visible = document.visibilityState === 'visible'
      setLive(visible)
      // Catch up immediately on return rather than waiting out the interval.
      if (visible) router.refresh()
    }

    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [router])

  useEffect(() => {
    if (!live) return
    const id = setInterval(() => router.refresh(), seconds * 1000)
    return () => clearInterval(id)
  }, [live, seconds, router])

  return null
}

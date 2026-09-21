import { clientEnv } from '@/lib/env'
import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'

import './globals.css'
import { ServiceWorker } from '@/components/service-worker'

/**
 * Typeface. To change it, swap the two imports below — nothing else in the app
 * names a font family; everything reads --font-ui and --font-data.
 *
 * Inter for the interface: chosen for being neutral rather than characterful.
 * This is a screen people stare at for hours, and the job of the type here is
 * to get out of the way of the data. Wide apertures keep it even at the 12–14px
 * the dense lists live at.
 *
 * JetBrains Mono for figures. Its zero is slashed and its 1/l/I are clearly
 * distinct, which matters in a screen full of counts, timestamps and ids.
 */
const ui = Inter({
  subsets: ['latin'],
  variable: '--font-ui',
  display: 'swap',
})

const data = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-data',
  display: 'swap',
})

/**
 * Phone chrome.
 *
 * viewport-fit=cover lets the layout run under the notch and the home indicator,
 * which is what makes an installed app look installed rather than like a page in
 * a browser. The bottom tab bar pays for that by padding itself with the safe
 * area — see MobileTabs.
 *
 * maximumScale is left alone deliberately: blocking pinch-zoom on a dense inbox
 * is a real accessibility loss and saves nothing.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#1AA05C' },
    { media: '(prefers-color-scheme: dark)', color: '#0C0E13' },
  ],
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
}

export const metadata: Metadata = {
  title: 'Upwork Agency Portal',
  applicationName: 'Agency',
  // Standalone on iOS, where the manifest's display mode is still not honoured.
  appleWebApp: { capable: true, title: 'Agency', statusBarStyle: 'default' },
  description: `Internal operations portal for the ${clientEnv.NEXT_PUBLIC_AGENCY_NAME} team`,

  // Internal tool behind a login: it should never appear in a search index.
  // Paired with the X-Robots-Tag header in next.config.ts, which also covers
  // responses a crawler might reach without parsing HTML.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      'max-snippet': 0,
      'max-image-preview': 'none',
    },
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${data.variable}`}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  )
}

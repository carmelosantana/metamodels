import './globals.css'
import type { ReactNode } from 'react'
import localFont from 'next/font/local'

// Vendored (fonts/SOURCES.md, ruling F10): the build fetches nothing, so a Google Fonts hiccup cannot fail it.
// Same families, weights and CSS variables as the next/font/google setup this replaced.
const ibmPlexSans = localFont({
  src: [{ path: './fonts/IBMPlexSans[wdth,wght].ttf', weight: '400 600', style: 'normal' }],
  variable: '--font-ibm-plex-sans',
})

const ibmPlexMono = localFont({
  src: [
    { path: './fonts/IBMPlexMono-Regular.ttf', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexMono-Medium.ttf', weight: '500', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  // Not preloaded (Kanboard #4721): two ~135 KB TTFs on every page, for a face only some pages use.
  preload: false,
})

export const metadata = { title: 'MetaModels', description: 'Operator console' }

/**
 * Every page renders per-request so middleware's CSP nonce can be stamped onto the script
 * tags Next emits. A prerendered page is baked at build time with no nonce, and the
 * `'strict-dynamic'` policy would then block its own bootstrap. Costs nothing here: every
 * route in this console is session-scoped and already dynamic.
 */
export const dynamic = 'force-dynamic'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${ibmPlexSans.variable} ${ibmPlexMono.variable}`}>
      <body>{children}</body>
    </html>
  )
}

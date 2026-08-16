import './globals.css'
import type { ReactNode } from 'react'
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google'

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-sans',
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-ibm-plex-mono',
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

# Vendored fonts

Loaded by `../layout.tsx` with `next/font/local`, so the console build fetches nothing (ruling F10 of
`docs/superpowers/plans/2026-09-30-m4-followups.md`). Files are upstream's, byte for byte; `SHA256SUMS`
pins them (`sha256sum -c SHA256SUMS`).

| File | Source (google/fonts @ `9710da1eacb3be272583c3224dcb70f9da6eadbb`) |
|---|---|
| `IBMPlexSans[wdth,wght].ttf` | `https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ibmplexsans/IBMPlexSans%5Bwdth,wght%5D.ttf` |
| `IBMPlexMono-Regular.ttf` | `https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ibmplexmono/IBMPlexMono-Regular.ttf` |
| `IBMPlexMono-Medium.ttf` | `https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ibmplexmono/IBMPlexMono-Medium.ttf` |
| `OFL.txt` | `https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ibmplexsans/OFL.txt` (identical to `ofl/ibmplexmono/OFL.txt`) |

IBM Plex is © 2017 IBM Corp., licensed under the SIL Open Font License 1.1 (`OFL.txt`), with Reserved
Font Name "Plex". To update: pick a new google/fonts commit, re-download, and regenerate `SHA256SUMS`.

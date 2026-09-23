import { randomBytes } from 'node:crypto'

// Services seal upstream credentials under this key, read from env the way production reads it.
// Random per run, so nothing a test seals can be opened by any other process.
process.env.UPSTREAM_AUTH_KEY ??= randomBytes(32).toString('base64')

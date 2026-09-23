import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildOpenApiDocument } from '../src/server/openapi'

/**
 * Writes the committed copy of the document. CI runs this and then `git diff --exit-code` on the
 * output, so a route change that nobody described fails the build rather than shipping a document
 * that quietly describes last month's API.
 *
 * Two spaces and a trailing newline because this file is reviewed as a diff, not as a payload.
 */
const OUT = join(import.meta.dirname, '../../../docs/api/openapi.json')

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`)
console.log(`wrote ${OUT}`)

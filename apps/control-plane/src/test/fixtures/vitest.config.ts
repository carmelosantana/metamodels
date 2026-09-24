import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Runs the fixtures in this folder, in file order, for db.test.ts. They are not part of the suite:
// some of their cases are meant to fail.
export default defineConfig({
  test: {
    root: dirname(fileURLToPath(import.meta.url)),
    include: ['*.fixture.ts'],
    environment: 'node',
    sequence: { shuffle: false },
  },
})

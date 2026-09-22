import { describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import { parsePathId } from './path-id'
import { problemForError } from './problem'

describe('parsePathId', () => {
  test('returns a uuid unchanged', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(parsePathId(id)).toBe(id)
  })

  test.each([['a name', 'my-flock'], ['empty', ''], ['a truncated uuid', '11111111-2222'], ['a bare number', '7']])(
    'rejects %s', (_why, v) => {
      expect(() => parsePathId(v)).toThrow(ZodError)
    })

  // The whole reason the helper exists: `problemForError` must turn what it throws into the 422 the
  // ruling calls for, not the opaque 500 an unmapped error becomes.
  test('what it throws is a 422 problem naming the id segment', async () => {
    let caught: unknown
    try { parsePathId('my-flock') } catch (e) { caught = e }
    const res = problemForError(caught)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    const body = await res.json() as { status: number; errors: { path: string; message: string }[] }
    expect(body.status).toBe(422)
    expect(body.errors).toEqual([{ path: 'id', message: 'path id must be a uuid' }])
  })

  // The segment is attacker-controlled and reflecting it would make this response an echo surface.
  // Anchored on a positive assertion first: the negative alone passes against an empty body.
  test('does not echo the offending segment back to the caller', async () => {
    let caught: unknown
    try { parsePathId('<script>alert(1)</script>') } catch (e) { caught = e }
    const text = await problemForError(caught).text()
    expect(text).toContain('path id must be a uuid')
    expect(text).not.toContain('script')
  })
})

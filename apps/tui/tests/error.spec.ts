/** Actionable terminal classification of stable Host Remote failures. */

import { describe, expect, it } from 'vitest'
import { friendlyError } from '../src/app.ts'
import { TuiError } from '../src/error.ts'

describe('terminal error classification', () => {
  it.each([
    ['ACCOUNT_QUOTA', 'quota'],
    ['RATE_LIMIT', 'rate limit'],
    ['REQUEST_TIMEOUT', 'timed out'],
    ['TRANSPORT_FAILED', 'connection failed'],
    ['STREAM_CLOSED', 'closed early'],
    ['EMPTY_RESPONSE', 'no content'],
  ])('routes %s by its stable code', (code, expected) => {
    expect(friendlyError(new TuiError('REMOTE_FAILED', 'detail', undefined, code))).toContain(expected)
  })

  it('keeps unclassified and plain errors readable', () => {
    expect(friendlyError(new Error('plain'))).toBe('plain')
    expect(friendlyError(new TuiError('REMOTE_FAILED', 'detail', undefined, 'OTHER'))).toBe('detail')
  })
})

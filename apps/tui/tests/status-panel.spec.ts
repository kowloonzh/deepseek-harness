import { describe, expect, it } from 'vitest'
import { activityReading, formatDuration, outputSpeed } from '../src/status-panel.ts'

const stats = { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }

describe('status panel readings', () => {
  it('formats durations compactly at every scale', () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(45_200)).toBe('45.2s')
    expect(formatDuration(162_000)).toBe('2m42s')
    expect(formatDuration(3_900_000)).toBe('1h05m')
  })

  it('reads output speed only from decode-timed steps', () => {
    expect(outputSpeed(stats)).toBeUndefined()
    expect(outputSpeed({ ...stats, decodeMs: 2_000, decodeTokens: 15 })).toBe('7.5 tok/s')
    expect(outputSpeed({ ...stats, decodeMs: 20_000, decodeTokens: 1_240 })).toBe('62 tok/s')
  })

  it('leaves the status row reading out until a step closes', () => {
    expect(activityReading(undefined)).toBeUndefined()
    expect(activityReading(stats)).toBeUndefined()
    expect(activityReading({ ...stats, turns: 12, steps: 48 })).toBe('12 turns/48 steps')
  })
})

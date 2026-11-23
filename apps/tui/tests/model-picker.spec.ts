/** Model picker: choosing a route and its reasoning depth together. */

import { describe, expect, it } from 'vitest'
import { defaultEffortIndex, modelChoices } from '../src/ui.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'

const catalog = {
  default: { provider: 'deepseek', model: 'deepseek-v4' },
  routableProviders: ['deepseek', 'plain'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4',
          name: 'DeepSeek V4',
          reasoning: {
            efforts: [
              { id: 'off', name: 'Off' },
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High', description: 'Deep reasoning' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
        },
      ],
    },
    {
      id: 'plain',
      name: 'Plain',
      models: [{ id: 'plain-chat', name: 'Plain Chat' }],
    },
  ],
  failures: [],
} as unknown as ModelCatalog

describe('model choices carry reasoning depths', () => {
  it('keeps each route effort list and host default', () => {
    const [deepseek, plain] = modelChoices(catalog)
    expect(deepseek?.efforts.map(effort => effort.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(deepseek?.defaultEffort).toBe('high')
    // A route without reasoning metadata offers nothing to pick.
    expect(plain?.efforts).toEqual([])
    expect(plain?.defaultEffort).toBeUndefined()
  })

  it('preserves effort descriptions when the host supplies them', () => {
    const high = modelChoices(catalog)[0]?.efforts.find(effort => effort.id === 'high')
    expect(high?.description).toBe('Deep reasoning')
  })

  it('indexes the current depth, else the host default, else the first', () => {
    const choice = modelChoices(catalog)[0]
    expect(defaultEffortIndex(choice, 'max')).toBe(3)
    expect(defaultEffortIndex(choice)).toBe(2)
    // An unknown depth falls back to the first entry rather than an out-of-range index.
    expect(defaultEffortIndex(choice, 'nonexistent')).toBe(0)
  })

  it('indexes the first depth for a route without a default', () => {
    const choice = { ...modelChoices(catalog)[0], defaultEffort: undefined }
    expect(defaultEffortIndex(choice)).toBe(0)
  })
})

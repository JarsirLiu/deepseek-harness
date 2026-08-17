import { describe, expect, it, vi } from 'vitest'
import { apply, Config, name } from '../src/index.ts'

describe('hub-server plugin entry', () => {
  it('exposes the plugin metadata and installs teardown', async () => {
    const teardowns: Array<() => unknown> = []
    const ctx = {
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: () => undefined,
      effect: vi.fn((effect: () => () => unknown) => {
        teardowns.push(effect())
        return vi.fn()
      }),
    }

    expect(name).toBe('hub-server')
    expect(Config).toBeDefined()
    apply(ctx as never, { endpointId: 'remote:test', port: 0 })
    expect(ctx.effect).toHaveBeenCalledOnce()
    expect(teardowns).toHaveLength(1)
    await teardowns[0]!()
  })
})

import { describe, expect, it, vi } from 'vitest'

const providers: FakeProvider[] = []

class FakeProvider {
  readonly config: { uri: string; token?: string }
  connectedServerInfo: { endpointId: `remote:${string}` } | null = null
  connect = vi.fn(async () => { this.connectedServerInfo = { endpointId: `remote:${this.config.uri}` as `remote:${string}` } })
  disconnect = vi.fn(() => { this.connectedServerInfo = null })

  constructor(_ctx: unknown, config: { uri: string; token?: string }) {
    this.config = config
    providers.push(this)
  }
}

vi.mock('../src/remote-session-provider.ts', () => ({ RemoteSessionProvider: FakeProvider }))

const { HubConnectionManager } = await import('../src/connection-manager.ts')

type EndpointInput = { id: string; label: string; uri: string; credentialRef?: string; enabled: boolean }

function setup(initial: { endpoints: EndpointInput[] } = { endpoints: [] }) {
  let value = initial
  let watcher: ((next: typeof value) => void) | undefined
  const settings = {
    get: () => value,
    replace: vi.fn(async (next: typeof value) => { value = next; watcher?.(next) }),
    watch: vi.fn((callback: typeof watcher) => { watcher = callback; return () => { watcher = undefined } }),
  }
  const ctx = {
    credentials: {
      resolve: vi.fn(async (ref: string) => ref === 'HUB_TOKEN'
        ? { value: 'secret', source: 'test' }
        : undefined),
    },
  }
  return { manager: new HubConnectionManager(ctx as never, settings as never), settings, ctx }
}

describe('HubConnectionManager', () => {
  it('persists an endpoint and manages its provider lifecycle', async () => {
    const { manager, settings } = setup()
    const state = await manager.create({ id: 'one', label: 'One', uri: 'first', enabled: false })

    expect(settings.replace).toHaveBeenCalledWith({ endpoints: [{ id: 'one', label: 'One', uri: 'first', enabled: false }] })
    expect(state.status).toBe('disconnected')
    await expect(manager.connect('one')).resolves.toMatchObject({ id: 'one', status: 'connected', endpointId: 'remote:first' })
    manager.disconnect('one')
    expect(manager.list()[0]?.status).toBe('disconnected')
    await manager.delete('one')
    expect(manager.list()).toEqual([])
  })

  it('resolves credential references before constructing a provider', async () => {
    const { manager, ctx } = setup()
    await manager.create({ id: 'secure', label: 'Secure', uri: 'secure', credentialRef: 'HUB_TOKEN', enabled: false })
    expect(ctx.credentials.resolve).toHaveBeenCalledWith('HUB_TOKEN')
    expect(providers.at(-1)?.config).toEqual({ uri: 'secure', token: 'secret' })
  })

  it('replaces the provider when connection settings change', async () => {
    const { manager } = setup()
    await manager.create({ id: 'one', label: 'One', uri: 'first', enabled: false })
    const first = providers.at(-1)
    await manager.update('one', { uri: 'second' })
    expect(first?.disconnect).toHaveBeenCalled()
    expect(providers.at(-1)?.config.uri).toBe('second')
  })

  it('does not expose secret values in endpoint state', async () => {
    const { manager } = setup()
    await manager.create({ id: 'secure', label: 'Secure', uri: 'secure', credentialRef: 'HUB_TOKEN', enabled: false })
    expect(JSON.stringify(manager.list())).not.toContain('secret')
  })
})

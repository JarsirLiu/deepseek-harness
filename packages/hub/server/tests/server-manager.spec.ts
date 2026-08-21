import { describe, expect, it, vi } from 'vitest'
import type { HubServer } from '../src/server.ts'
import { HubServerManager, type HubServerSettings } from '../src/server-manager.ts'

function settings(initial: HubServerSettings) {
  let value = initial
  const listeners: Array<(next: HubServerSettings, prev: HubServerSettings) => void> = []
  return {
    get: () => value,
    update: async (patch: object) => {
      const previous = value
      value = { ...value, ...patch } as HubServerSettings
      for (const listener of listeners) listener(value, previous)
    },
    watch: (listener: (next: HubServerSettings, prev: HubServerSettings) => void) => { listeners.push(listener); return () => {} },
    replace: async (next: object) => { value = next as HubServerSettings },
  }
}

function fakeServer() {
  return {
    start: vi.fn(),
    waitUntilListening: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as HubServer
}

const config: HubServerSettings = {
  endpointId: 'remote:local', serverName: 'test', host: '127.0.0.1', port: 8765, credentialRef: '', enabled: false,
}

describe('HubServerManager', () => {
  it('starts and stops a configured listener without exposing credentials', async () => {
    const server = fakeServer()
    const manager = new HubServerManager({ credentials: { resolve: vi.fn() } } as never, settings(config), () => server)
    await expect(manager.start()).resolves.toMatchObject({ status: 'running', credentialRef: '' })
    expect(server.start).toHaveBeenCalledOnce()
    await manager.stop()
    expect(server.stop).toHaveBeenCalledOnce()
  })

  it('resolves a credential reference only when building server configuration', async () => {
    const resolve = vi.fn(async () => ({ value: 'secret', source: 'test' }))
    let received: unknown
    const manager = new HubServerManager({ credentials: { resolve } } as never, settings({ ...config, credentialRef: 'HUB_TOKEN' }), (value) => { received = value; return fakeServer() })
    await manager.start()
    expect(resolve).toHaveBeenCalledOnce()
    expect(received).toMatchObject({ authTokens: ['secret'] })
    expect(manager.get()).not.toHaveProperty('token')
  })

  it('creates the startup credential before the listener begins', async () => {
    const credentials = {
      resolve: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
    }
    let received: unknown
    const manager = new HubServerManager({ credentials } as never, settings({ ...config, credentialRef: 'HUB_TOKEN' }), (value) => {
      received = value
      return fakeServer()
    })
    await manager.start()
    expect(credentials.set).toHaveBeenCalledOnce()
    expect(received).toMatchObject({ authTokens: [expect.any(String)] })
  })

  it('reports a failed bind and leaves no running server', async () => {
    const server = fakeServer()
    vi.mocked(server.waitUntilListening).mockRejectedValueOnce(new Error('EADDRINUSE'))
    const manager = new HubServerManager({ credentials: { resolve: vi.fn() } } as never, settings(config), () => server)
    await expect(manager.start()).rejects.toThrow('EADDRINUSE')
    expect(manager.get()).toMatchObject({ status: 'error', error: 'EADDRINUSE' })
  })

  it('creates a reusable credential and rotates it', async () => {
    const credentials = {
      resolve: vi.fn<(ref: string) => Promise<{ value: string; source: string } | undefined>>(async () => undefined),
      set: vi.fn(async () => {}),
    }
    const manager = new HubServerManager({ credentials } as never, settings({ ...config, credentialRef: 'HUB_TOKEN' }), () => fakeServer())
    const first = await manager.connectionCredential()
    expect(first).toMatch(/^dshhub:v1:/)
    expect(credentials.set).toHaveBeenCalledOnce()
    credentials.resolve.mockResolvedValue({ value: 'persisted', source: 'test' })
    await expect(manager.connectionCredential()).resolves.toMatch(/^dshhub:v1:/)
    await manager.disableCredential()
    await expect(manager.connectionCredential()).rejects.toThrow('disabled')
    await manager.regenerateCredential()
    expect(credentials.set).toHaveBeenCalledTimes(2)
  })
})

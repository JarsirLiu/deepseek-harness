import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { JsonRpcWebSocketTransport } from '@deepseek-ai/dsh-hub-protocol'
import { HubServer } from '../src/server.ts'

const workspace = { id: 'workspace-a', path: 'D:/workspace-a', sessionIds: ['session-a' as never] }

function waitFor<T>(predicate: () => T | undefined, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error(`timed out waiting for ${label}`)) }, 1000)
    const check = (): void => {
      const value = predicate()
      if (value !== undefined) {
        clearTimeout(timeout)
        resolve(value)
      }
      else setTimeout(check, 1)
    }
    check()
  })
}

describe('HubServer WebSocket lifecycle', () => {
  it('forwards the unchanged Host frame and aborts the stream on shutdown', async () => {
    let releaseFrame: ((frame: HostFrame) => void) | undefined
    let streamAborted = false
    const host = vi.fn(async function* (_request: unknown, signal: AbortSignal) {
      const frame = await new Promise<HostFrame>((resolve, reject) => {
        releaseFrame = resolve
        signal.addEventListener('abort', () => {
          streamAborted = true
          reject(new Error('host stream aborted'))
        }, { once: true })
      })
      yield { payload: frame }
    })
    const disposers = [vi.fn(), vi.fn()]
    let disposerIndex = 0
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => disposers[disposerIndex++] ?? vi.fn()),
      get: (key: string) => key === 'workspaceRegistry' ? { list: () => [workspace] }
        : key === 'apiProxy' ? { events: { host } } : undefined,
    } as never, { endpointId: 'remote:broker', port: 0 })

    server.start()
    await server.waitUntilListening()
    const httpServer = (server as unknown as { httpServer: { address: () => AddressInfo } }).httpServer
    const { port } = httpServer.address()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hub`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const transport = new JsonRpcWebSocketTransport(socket)
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
    transport.onNotification((method, params) => { notifications.push({ method, params }) })
    transport.start()

    await expect(transport.request('hub/handshake', {})).resolves.toMatchObject({ endpointId: 'remote:broker' })
    await transport.request('hub/subscribe-workspaces', {
      workspaces: [{ endpointId: 'remote:broker', workspaceId: 'workspace-a' }],
    })
    await waitFor(() => { return releaseFrame }, 'host stream start')

    const frame = { type: 'host/session-status', sessionId: 'session-a', running: true } as never as HostFrame
    releaseFrame!(frame)
    await waitFor(() => { return notifications.find(notification => notification.method === 'hub/host') }, 'host notification')
    expect(notifications).toContainEqual({
      method: 'hub/host',
      params: { endpointId: 'remote:broker', workspaceId: 'workspace-a', frame },
    })

    await server.stop()
    expect(streamAborted).toBe(true)
    expect(disposers[0]).toHaveBeenCalledOnce()
    expect(disposers[1]).toHaveBeenCalledOnce()
    expect((server as unknown as { clients: Map<string, unknown> }).clients.size).toBe(0)
    transport.close()
  })

  it('reports a Host stream failure as a notification', async () => {
    const host = vi.fn(async function* () {
      throw new Error('host stream failed')
    })
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: (key: string) => key === 'workspaceRegistry' ? { list: () => [workspace] }
        : key === 'apiProxy' ? { events: { host } } : undefined,
    } as never, { endpointId: 'remote:broker', port: 0 })

    server.start()
    await server.waitUntilListening()
    const { port } = (server as unknown as { httpServer: { address: () => AddressInfo } }).httpServer.address()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hub`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const transport = new JsonRpcWebSocketTransport(socket)
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
    transport.onNotification((method, params) => { notifications.push({ method, params }) })
    transport.start()

    await transport.request('hub/handshake', {})
    await transport.request('hub/subscribe-workspaces', {
      workspaces: [{ endpointId: 'remote:broker', workspaceId: 'workspace-a' }],
    })
    const errorNotification = await waitFor(() => { return notifications.find(notification => notification.method === 'hub/host') }, 'stream error notification')
    expect(errorNotification.params).toEqual({
      endpointId: 'remote:broker',
      workspaceId: null,
      frame: { type: 'stream/error', error: { code: 'internal', message: 'host stream failed' } },
    })

    await server.stop()
    transport.close()
  })
})

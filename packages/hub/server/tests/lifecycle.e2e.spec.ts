import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import { JsonRpcWebSocketTransport } from '@deepseek-ai/dsh-hub-protocol'
import { HubServer } from '../src/server.ts'

const workspace = { id: 'workspace-a', path: 'D:/workspace-a', sessionIds: ['session-a' as never] }

async function* emptyHostStream(): AsyncGenerator<never> {
  return
}

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
  it('rejects non-Hub upgrade paths and keeps start idempotent', async () => {
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: () => undefined,
    } as never, { endpointId: 'remote:broker', port: 0 })

    server.start()
    server.start()
    await server.waitUntilListening()
    const { port } = (server as unknown as { httpServer: { address: () => AddressInfo } }).httpServer.address()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wrong-path`)
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.once('error', () => resolve())
    })
    await server.stop()
  })

  it('rejects a listener that cannot bind its configured port', async () => {
    const first = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: () => undefined,
    } as never, { endpointId: 'remote:first', port: 0 })
    first.start()
    await first.waitUntilListening()
    const port = ((first as unknown as { httpServer: { address: () => AddressInfo } }).httpServer.address()).port
    const second = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: () => undefined,
    } as never, { endpointId: 'remote:second', port })
    second.start()
    await expect(second.waitUntilListening()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await second.stop()
    await first.stop()
  })

  it('uses safe defaults for an upgrade request without URL or Host', () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const httpServer = (server as unknown as { httpServer: { emit: (event: string, ...args: unknown[]) => boolean } }).httpServer
    const socket = { destroy: vi.fn() }
    httpServer.emit('upgrade', { headers: {} }, socket, Buffer.alloc(0))
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it('rejects an invalid handshake token without starting the Host stream', async () => {
    const host = vi.fn(emptyHostStream)
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: (key: string) => key === 'apiProxy' ? { events: { host } } : undefined,
    } as never, { endpointId: 'remote:broker', authTokens: ['secret'], port: 0 })
    server.start()
    await server.waitUntilListening()
    const { port } = (server as unknown as { httpServer: { address: () => AddressInfo } }).httpServer.address()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/hub`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const transport = new JsonRpcWebSocketTransport(socket)
    transport.start()
    await expect(transport.request('hub/handshake', { token: 'wrong' })).rejects.toThrow('authentication failed')
    expect(host).not.toHaveBeenCalled()
    await server.stop()
    transport.close()
  })

  it('reports a missing Host event API during handshake', async () => {
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: () => undefined,
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
    transport.start()
    await expect(transport.request('hub/handshake', {})).rejects.toThrow('remote host event API is unavailable')
    await server.stop()
    transport.close()
  })

  it('registers an Agent, publishes workspaces, and exposes the endpoint', async () => {
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: (key: string) => key === 'apiProxy' ? { events: { host: emptyHostStream } } : undefined,
    } as never, {
      endpointId: 'remote:broker',
      agentTokens: { 'remote:agent': 'agent-secret' },
      port: 0,
    })
    server.start()
    await server.waitUntilListening()
    const { port } = (server as unknown as { httpServer: { address: () => AddressInfo } }).httpServer.address()
    const agentSocket = new WebSocket(`ws://127.0.0.1:${port}/hub`)
    await new Promise<void>((resolve, reject) => {
      agentSocket.once('open', resolve)
      agentSocket.once('error', reject)
    })
    const agent = new JsonRpcWebSocketTransport(agentSocket)
    agent.start()
    await expect(agent.request('hub/agent/register', {
      endpointId: 'remote:agent',
      token: 'agent-secret',
      serverInfo: { name: 'agent', version: '1' },
      workspaces: [],
    })).resolves.toMatchObject({ endpointId: 'remote:agent' })
    await expect(agent.request('hub/agent/publish-workspaces', {
      workspaces: [{ endpointId: 'remote:agent', id: 'workspace-a', title: 'A', path: '/a', sessions: [] }],
    })).resolves.toEqual({})

    const clientSocket = new WebSocket(`ws://127.0.0.1:${port}/hub`)
    await new Promise<void>((resolve, reject) => {
      clientSocket.once('open', resolve)
      clientSocket.once('error', reject)
    })
    const client = new JsonRpcWebSocketTransport(clientSocket)
    client.start()
    await client.request('hub/handshake', {})
    await expect(client.request('hub/list-endpoints', {})).resolves.toMatchObject({
      endpoints: [{ endpointId: 'remote:broker' }, { endpointId: 'remote:agent', workspaces: [{ id: 'workspace-a' }] }],
    })
    await server.stop()
    agent.close()
    client.close()
  })

  it('keeps the client workspace projection empty until a workspace is selected', async () => {
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: (key: string) => key === 'apiProxy' ? { events: { host: emptyHostStream } } : undefined,
    } as never, {
      endpointId: 'remote:broker',
      agentTokens: { 'remote:agent': 'agent-secret' },
      port: 0,
    })
    server.start()
    await server.waitUntilListening()
    const { port } = (server as unknown as { httpServer: { address: () => AddressInfo } }).httpServer.address()
    const connect = async (): Promise<JsonRpcWebSocketTransport> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/hub`)
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      const transport = new JsonRpcWebSocketTransport(socket)
      transport.start()
      return transport
    }
    const agent = await connect()
    await agent.request('hub/agent/register', {
      endpointId: 'remote:agent',
      token: 'agent-secret',
      serverInfo: { name: 'agent', version: '1' },
      workspaces: [{ endpointId: 'remote:agent', id: 'workspace-a', title: 'A', path: '/a', sessions: [] }],
    })
    const client = await connect()
    await client.request('hub/handshake', {})

    await expect(client.request('hub/workspaces', { workspaces: [] })).resolves.toEqual({
      endpointId: 'remote:broker',
      workspaces: [],
    })
    await expect(client.request('hub/workspaces', {
      workspaces: [{ endpointId: 'remote:agent', workspaceId: 'workspace-a' }],
    })).resolves.toEqual({
      endpointId: 'remote:broker',
      workspaces: [{ endpointId: 'remote:agent', id: 'workspace-a', title: 'A', path: '/a', sessions: [] }],
    })

    await server.stop()
    agent.close()
    client.close()
  })

  it('forwards Agent notifications only to clients subscribed to that endpoint workspace', async () => {
    const server = new HubServer({
      logger: { info: vi.fn(), warn: vi.fn() },
      on: vi.fn(() => vi.fn()),
      get: (key: string) => key === 'apiProxy' ? { events: { host: emptyHostStream } } : undefined,
    } as never, {
      endpointId: 'remote:broker', agentTokens: { 'remote:agent': 'agent-secret' }, port: 0,
    })
    server.start()
    await server.waitUntilListening()
    const { port } = (server as unknown as { httpServer: { address: () => AddressInfo } }).httpServer.address()
    const connect = async (): Promise<JsonRpcWebSocketTransport> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/hub`)
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      const transport = new JsonRpcWebSocketTransport(socket)
      transport.start()
      return transport
    }
    const agent = await connect()
    await agent.request('hub/agent/register', {
      endpointId: 'remote:agent', token: 'agent-secret', serverInfo: { name: 'agent', version: '1' },
      workspaces: [{ endpointId: 'remote:agent', id: 'workspace-a', title: 'A', path: '/a', sessions: [
        { endpointId: 'remote:agent', sessionId: 'session-a', updatedAt: 1, running: false, blank: false },
      ] }],
    })
    const client = await connect()
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
    client.onNotification((method, params) => { notifications.push({ method, params }) })
    await client.request('hub/handshake', {})
    await client.request('hub/subscribe-workspaces', {
      workspaces: [{ endpointId: 'remote:agent', workspaceId: 'workspace-a' }],
    })
    agent.notify('hub/agent/host-event', {
      endpointId: 'remote:agent', workspaceId: 'workspace-a',
      frame: { type: 'host/session-status', sessionId: 'session-a', running: true },
    })
    agent.notify('hub/agent/event', {
      endpointId: 'remote:agent', workspaceId: 'workspace-a', sessionId: 'session-a',
      event: { type: 'assistant/chunk', content: 'hello' },
    })
    await waitFor(() => notifications.length === 2 ? notifications : undefined, 'Agent notifications')
    expect(notifications).toEqual(expect.arrayContaining([
      { method: 'hub/host', params: expect.objectContaining({ endpointId: 'remote:agent', workspaceId: 'workspace-a' }) },
      { method: 'hub/event', params: expect.objectContaining({ endpointId: 'remote:agent', sessionId: 'session-a' }) },
    ]))
    await server.stop()
    agent.close()
    client.close()
  })

  it('forwards session events and lifecycle status to the matching subscription', async () => {
    const listeners = new Map<string, (value: never) => void>()
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn((event: string, listener: (value: never) => void) => {
        listeners.set(event, listener)
        return vi.fn()
      }),
      get: (key: string) => key === 'workspaceRegistry'
        ? { list: () => [workspace] }
        : key === 'apiProxy' ? { events: { host: emptyHostStream } }
          : undefined,
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
    await transport.request('hub/subscribe', { id: 'session-a', workspaceId: 'workspace-a' })

    listeners.get('session/event')!({ id: 'session-a', event: { type: 'assistant/chunk', content: 'ok' } } as never)
    listeners.get('session/created')!({ id: 'session-a' } as never)
    listeners.get('session/disposed')!({ id: 'session-a' } as never)
    await waitFor(() => notifications.length === 3 ? notifications : undefined, 'session notifications')
    expect(notifications.map(({ method }) => method)).toEqual(['hub/event', 'hub/status', 'hub/status'])
    expect(notifications[0]?.params).toMatchObject({ endpointId: 'remote:broker', workspaceId: 'workspace-a', sessionId: 'session-a' })
    await server.stop()
    transport.close()
  })

  it('dispatches list, endpoint, unsubscribe and unknown requests through the protocol', async () => {
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn(() => vi.fn()),
      sessions: { list: () => [] },
      get: (key: string) => key === 'workspaceRegistry' ? { list: () => [], archivedSessionIds: [] }
        : key === 'apiProxy' ? { events: { host: emptyHostStream } }
          : undefined,
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
    transport.start()
    await expect(transport.request('hub/handshake', {})).resolves.toMatchObject({ endpointId: 'remote:broker' })
    await expect(transport.request('hub/list', {})).resolves.toEqual({ sessions: [] })
    await expect(transport.request('hub/list-endpoints', {})).resolves.toMatchObject({ endpoints: [{ endpointId: 'remote:broker' }] })
    await expect(transport.request('hub/subscribe', {})).resolves.toEqual({})
    await expect(transport.request('hub/unsubscribe', {})).resolves.toEqual({})
    await expect(transport.request('hub/no-such-method', {})).rejects.toThrow('unknown hub method')
    await server.stop()
    transport.close()
  })

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

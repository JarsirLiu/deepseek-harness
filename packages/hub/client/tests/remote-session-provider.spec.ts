import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  readyState = FakeWebSocket.OPEN
  sent: string[] = []

  constructor(readonly uri: string) {
    super()
    queueMicrotask(() => this.emit('open'))
  }

  send(data: string): void {
    this.sent.push(data)
    const request = JSON.parse(data) as { id: string; method: string }
    if (request.method === 'hub/handshake') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: {
          endpointId: 'remote:test',
          serverInfo: { name: 'test', version: '1' },
          capabilities: { subscriptions: true, delete: true },
        },
      })))
    } else {
      queueMicrotask(() => this.emit('message', JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })))
    }
  }

  close(): void {
    this.readyState = 3
    this.emit('close', 1000, Buffer.alloc(0))
  }
}

const sockets: FakeWebSocket[] = []
vi.mock('ws', () => ({
  default: class extends FakeWebSocket {
    constructor(uri: string) {
      super(uri)
      sockets.push(this)
    }
  },
}))

const { RemoteSessionProvider, HubConnectionError } = await import('../src/remote-session-provider.ts')

describe('RemoteSessionProvider', () => {
  it('connects once, performs handshake, and subscribes selected workspaces', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test', token: 'secret' })
    expect(provider.connectionState).toBe('disconnected')
    await provider.connect()
    await provider.connect()
    expect(provider.isConnected).toBe(true)
    expect(provider.connectedServerInfo?.endpointId).toBe('remote:test')
    await provider.subscribeWorkspaces(['workspace-a'])
    const messages = sockets[0]!.sent.map(message => JSON.parse(message) as { method: string; params: Record<string, unknown> })
    expect(messages.map(message => message.method)).toEqual(['hub/handshake', 'hub/subscribe-workspaces'])
    expect(messages[1]?.params).toEqual({ workspaceIds: ['workspace-a'] })
  })

  it('dispatches session, wildcard, status, and host notifications and disposes listeners', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    await provider.connect()
    const session = vi.fn()
    const wildcard = vi.fn()
    const status = vi.fn()
    const host = vi.fn()
    const disposeSession = provider.subscribe('session-a' as never, session)
    const disposeWildcard = provider.onEvent(wildcard)
    const disposeStatus = provider.onStatus(status)
    const disposeHost = provider.onHostFrame(host)
    const socket = sockets.at(-1)!
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/event', params: { sessionId: 'session-a' } }))
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/status', params: { status: 'running' } }))
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/host', params: { frame: { type: 'host/session-status' } } }))
    expect(session).toHaveBeenCalledTimes(1)
    expect(wildcard).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledTimes(1)
    expect(host).toHaveBeenCalledTimes(1)
    disposeSession(); disposeWildcard(); disposeStatus(); disposeHost()
    await new Promise(resolve => setTimeout(resolve, 0))
    provider.disconnect()
    expect(provider.connectionState).toBe('disconnected')
  })

  it('rejects requests while disconnected', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    expect(provider.isConnected).toBe(false)
    expect(() => provider.request('hub/list', {})).toThrow(HubConnectionError)
  })
})

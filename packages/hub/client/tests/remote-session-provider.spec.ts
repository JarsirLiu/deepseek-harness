import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  static behavior: 'open' | 'error' | 'timeout' | 'handshake-error' | 'invalid-handshake' = 'open'
  readyState = FakeWebSocket.OPEN
  sent: string[] = []

  constructor(readonly uri: string) {
    super()
    if (FakeWebSocket.behavior === 'open'
      || FakeWebSocket.behavior === 'handshake-error'
      || FakeWebSocket.behavior === 'invalid-handshake') {
      queueMicrotask(() => this.emit('open'))
    } else if (FakeWebSocket.behavior === 'error') {
      queueMicrotask(() => this.emit('error', new Error('connection refused')))
    }
  }

  send(data: string): void {
    this.sent.push(data)
    const request = JSON.parse(data) as { id: string; method: string }
    if (request.method === 'hub/handshake' && FakeWebSocket.behavior === 'handshake-error') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'invalid token' },
      })))
    } else if (request.method === 'hub/handshake') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: {
          endpointId: FakeWebSocket.behavior === 'invalid-handshake' ? 'configured-client-id' : 'remote:test',
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
  it('rejects a socket error and clears the failed connection', async () => {
    FakeWebSocket.behavior = 'error'
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })

    await expect(provider.connect()).rejects.toThrow('WebSocket error: connection refused')
    expect(provider.connectionState).toBe('error')
    expect(provider.isConnected).toBe(false)
    FakeWebSocket.behavior = 'open'
  })

  it('rejects when the socket never opens', async () => {
    vi.useFakeTimers()
    FakeWebSocket.behavior = 'timeout'
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    const connecting = provider.connect()
    const rejected = expect(connecting).rejects.toThrow('WebSocket connection timeout')
    await vi.advanceTimersByTimeAsync(10000)

    await rejected
    expect(provider.connectionState).toBe('error')
    expect(provider.isConnected).toBe(false)
    vi.useRealTimers()
    FakeWebSocket.behavior = 'open'
  })

  it('rejects a handshake error and does not retain transport state', async () => {
    FakeWebSocket.behavior = 'handshake-error'
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })

    await expect(provider.connect()).rejects.toThrow('invalid token')
    expect(provider.connectionState).toBe('error')
    expect(provider.connectedServerInfo).toBeNull()
    expect(() => provider.request('hub/list', {})).toThrow(HubConnectionError)
    FakeWebSocket.behavior = 'open'
  })

  it('rejects a handshake response without a Hub-owned endpoint identity', async () => {
    FakeWebSocket.behavior = 'invalid-handshake'
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })

    await expect(provider.connect()).rejects.toThrow('invalid hub handshake response')
    expect(provider.connectionState).toBe('error')
    expect(provider.connectedServerInfo).toBeNull()
    FakeWebSocket.behavior = 'open'
  })

  it('rejects a second connect while the first connection is pending', async () => {
    vi.useFakeTimers()
    FakeWebSocket.behavior = 'timeout'
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    const connecting = provider.connect()

    await expect(provider.connect()).rejects.toThrow('already connecting')
    const rejected = expect(connecting).rejects.toThrow('WebSocket connection timeout')
    await vi.advanceTimersByTimeAsync(10000)
    await rejected
    vi.useRealTimers()
    FakeWebSocket.behavior = 'open'
  })

  it('connects once, performs handshake, and subscribes selected workspaces', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test', token: 'secret' })
    expect(provider.connectionState).toBe('disconnected')
    await provider.connect()
    await provider.connect()
    expect(provider.isConnected).toBe(true)
    expect(provider.connectedServerInfo?.endpointId).toBe('remote:test')
    await provider.subscribeWorkspaces(['workspace-a'])
    const messages = sockets.at(-1)!.sent.map(message => JSON.parse(message) as { method: string; params: Record<string, unknown> })
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
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/event', params: { sessionId: 'unsubscribed' } }))
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/unknown', params: {} }))
    disposeSession(); disposeWildcard(); disposeStatus(); disposeHost()
    disposeSession(); disposeWildcard(); disposeStatus(); disposeHost()
    await new Promise(resolve => setTimeout(resolve, 0))
    provider.disconnect()
    expect(provider.connectionState).toBe('disconnected')
  })

  it('marks the provider disconnected when the socket closes', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    await provider.connect()
    const socket = sockets.at(-1)!

    socket.close()

    expect(provider.connectionState).toBe('disconnected')
    expect(provider.isConnected).toBe(false)
    expect(provider.connectedServerInfo).toBeTruthy()
  })

  it('marks the provider as errored after a connected socket error', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    await provider.connect()
    const socket = sockets.at(-1)!

    socket.emit('error', new Error('network lost'))

    expect(provider.connectionState).toBe('error')
    expect(provider.isConnected).toBe(false)
  })

  it('continues dispatching when one notification listener throws', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    await provider.connect()
    const first = vi.fn(() => { throw new Error('listener failed') })
    const second = vi.fn()
    provider.onStatus(first)
    provider.onStatus(second)
    provider.onHostFrame(first)
    provider.onHostFrame(second)
    provider.onEvent(first)
    provider.onEvent(second)
    const socket = sockets.at(-1)!

    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/status', params: {} }))
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/host', params: {} }))
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/event', params: { sessionId: 's1' } }))

    expect(second).toHaveBeenCalledTimes(3)
  })

  it('removes the remote session subscription after the last listener is disposed', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    await provider.connect()
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = provider.subscribe('s1' as never, first)
    const disposeSecond = provider.subscribe('s1' as never, second)
    disposeFirst()
    disposeSecond()
    disposeSecond()
    await new Promise(resolve => setTimeout(resolve, 0))

    const messages = sockets.at(-1)!.sent.map(message => JSON.parse(message) as { method: string })
    expect(messages.map(message => message.method)).toEqual([
      'hub/handshake', 'hub/subscribe', 'hub/unsubscribe',
    ])
  })

  it('clears the handshake result on explicit disconnect', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    await provider.connect()

    provider.disconnect()

    expect(provider.connectedServerInfo).toBeNull()
    expect(provider.connectionState).toBe('disconnected')
  })

  it('removes an empty wildcard listener set', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    await provider.connect()
    const dispose = provider.onEvent(vi.fn())
    const disposeOther = provider.onEvent(vi.fn())

    dispose()
    disposeOther()
    dispose()

    sockets.at(-1)!.emit('message', JSON.stringify({
      jsonrpc: '2.0', method: 'hub/event', params: { sessionId: 's1' },
    }))
  })

  it('rejects requests while disconnected', async () => {
    const provider = new RemoteSessionProvider({} as never, { uri: 'ws://test' })
    expect(provider.isConnected).toBe(false)
    expect(() => provider.request('hub/list', {})).toThrow(HubConnectionError)
  })
})

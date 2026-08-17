import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { HubWorkspaceDirectoryProvider } from '../src/workspace-directory.ts'
import type { HubWorkspaceDirectoryEntry } from '../src/workspace-directory.ts'

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = []
  static behavior: 'open' | 'socket-error' | 'registration-error' | 'invalid-registration' | 'empty-registration' = 'open'
  static registrationFailures = 0
  readyState = 1
  sent: string[] = []

  constructor(readonly uri: string) {
    super()
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => this.emit(FakeWebSocket.behavior === 'socket-error' ? 'error' : 'open', new Error('connection refused')))
  }

  send(data: string): void {
    this.sent.push(data)
    const request = JSON.parse(data) as { id: string; method: string }
    if (request.method === 'hub/agent/register'
      && (FakeWebSocket.behavior === 'registration-error' || FakeWebSocket.registrationFailures > 0)) {
      if (FakeWebSocket.registrationFailures > 0) FakeWebSocket.registrationFailures--
      queueMicrotask(() => this.emit('message', JSON.stringify({
        jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'registration rejected' },
      })))
      return
    }
    const result = request.method === 'hub/agent/register'
      ? FakeWebSocket.behavior === 'invalid-registration'
        ? { endpointId: 'remote:other', brokerInfo: { name: 'hub', version: '1' } }
        : FakeWebSocket.behavior === 'empty-registration'
          ? null
          : { endpointId: 'remote:agent', brokerInfo: { name: 'hub', version: '1' } }
      : {}
    queueMicrotask(() => this.emit('message', JSON.stringify({ jsonrpc: '2.0', id: request.id, result })))
  }

  close(): void {
    this.readyState = 3
    this.emit('close', 1000, Buffer.alloc(0))
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }))

const { HubEndpointAgent } = await import('../src/endpoint-agent.ts')

const workspace: HubWorkspaceDirectoryEntry = {
  id: 'workspace-a',
  title: 'Workspace A',
  path: 'D:/workspace-a',
  sessions: [],
}

function createAgent(
  apiProxy: Record<string, Record<string, (request: unknown) => Promise<unknown>>> = {},
  host: (signal: AbortSignal) => AsyncIterable<{ payload: unknown }> = async function* (_signal) {
    await new Promise<void>((resolve) => { _signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  },
  snapshots: HubWorkspaceDirectoryEntry[] = [workspace],
  snapshot?: (() => Promise<HubWorkspaceDirectoryEntry[]>)  ,
  agentConfig: { autoReconnect?: boolean; reconnectDelay?: number } = {},
  mux: (signal: AbortSignal) => AsyncIterable<{ payload: unknown }> = async function* (_signal) {
    await new Promise<void>((resolve) => { _signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  },
) {
  let snapshotIndex = 0
  return new HubEndpointAgent({
    uri: 'ws://hub.test/hub',
    endpointId: 'remote:agent',
    token: 'secret',
    serverInfo: { name: 'agent', version: '1' },
    apiProxy: {
      ...apiProxy,
      events: {
        host: (_request: unknown, signal: AbortSignal) => host(signal),
        mux: (_request: unknown, signal: AbortSignal) => mux(signal),
      },
    } as never,
    directory: {
      snapshot: vi.fn(snapshot ?? (async () => [snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!])),
    },
    ...agentConfig,
  })
}

describe('HubEndpointAgent', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.behavior = 'open'
    FakeWebSocket.registrationFailures = 0
  })

  it('builds the directory from the official workspace and session snapshots', async () => {
    const provider = new HubWorkspaceDirectoryProvider({
      workspace: { list: vi.fn(async () => ({ result: { ok: true, value: {
        items: [{ workspaceId: 'workspace-a', title: 'Workspace A', path: 'D:/workspace-a', sessionIds: ['session-a'] }],
        archivedSessionIds: [],
      } } })) },
      sessions: { list: vi.fn(async () => ({ result: { ok: true, value: { items: [{
        sessionId: 'session-a', updatedAt: 7, running: true, blank: false,
        projections: { values: { title: 'Session A' } },
      }] } } })) },
    } as never)

    await expect(provider.snapshot()).resolves.toEqual([{
      id: 'workspace-a', title: 'Workspace A', path: 'D:/workspace-a', sessions: [{
        sessionId: 'session-a', updatedAt: 7, running: true, blank: false, title: 'Session A',
      }],
    }])
  })

  it('registers workspaces and publishes a normalized registration request', async () => {
    const agent = createAgent()

    await expect(agent.connect()).resolves.toMatchObject({ endpointId: 'remote:agent' })
    expect(agent.registrationResult).toMatchObject({ endpointId: 'remote:agent' })
    const messages = FakeWebSocket.instances.at(-1)!.sent.map(message =>
      JSON.parse(message) as { method: string; params: Record<string, unknown> })
    expect(messages[0]?.method).toBe('hub/agent/register')
    expect(messages[0]?.params.workspaces).toEqual([{
      ...workspace,
      endpointId: 'remote:agent',
    }])

    await agent.disconnect()
    expect(agent.registrationResult).toBeNull()
    expect(() => { agent.publishHostEvent('workspace-a', { type: 'host/session-status', sessionId: 's1', running: true } as never) })
      .toThrow('not connected')
  })

  it('clears the socket and registration state when registration fails', async () => {
    const agent = createAgent()
    FakeWebSocket.behavior = 'registration-error'
    await expect(agent.connect()).rejects.toThrow('registration rejected')
    expect(agent.registrationResult).toBeNull()
    expect(() => { agent.publishHostEvent('workspace-a', { type: 'host/session-status' } as never) })
      .toThrow('not connected')
    FakeWebSocket.behavior = 'open'

    const invalidAgent = createAgent()
    FakeWebSocket.behavior = 'invalid-registration'
    await expect(invalidAgent.connect()).rejects.toThrow('invalid Endpoint Agent registration response')
    expect(invalidAgent.registrationResult).toBeNull()
    FakeWebSocket.behavior = 'open'
  })

  it('cleans up a socket that fails before opening', async () => {
    const agent = createAgent()
    FakeWebSocket.behavior = 'socket-error'
    await expect(agent.connect()).rejects.toThrow('connection refused')
    expect(agent.registrationResult).toBeNull()
    FakeWebSocket.behavior = 'open'
  })

  it('rejects a non-object registration response', async () => {
    const agent = createAgent()
    FakeWebSocket.behavior = 'empty-registration'
    await expect(agent.connect()).rejects.toThrow('invalid Endpoint Agent registration response')
    FakeWebSocket.behavior = 'open'
  })

  it('stops the Host stream after an unexpected close and re-registers a fresh directory', async () => {
    const updatedWorkspace = { ...workspace, title: 'Workspace B' }
    const hostSignals: AbortSignal[] = []
    const agent = createAgent({}, async function* (signal) {
      hostSignals.push(signal)
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }, [workspace, updatedWorkspace])
    await agent.connect()

    FakeWebSocket.instances.at(-1)!.close()

    expect(agent.registrationResult).toBeNull()
    expect(agent.hostStreamFailure).toBeInstanceOf(Error)
    expect((agent.hostStreamFailure as Error).message).toBe('Endpoint Agent Hub connection closed')
    expect(hostSignals[0]?.aborted).toBe(true)

    await agent.connect()
    const messages = FakeWebSocket.instances.at(-1)!.sent.map(message =>
      JSON.parse(message) as { method: string; params: Record<string, unknown> })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.method).toBe('hub/agent/register')
    expect(messages[0]?.params.workspaces).toEqual([{ ...updatedWorkspace, endpointId: 'remote:agent' }])
    expect(hostSignals).toHaveLength(2)
    await agent.disconnect()
  })

  it('automatically re-registers after an unexpected close', async () => {
    vi.useFakeTimers()
    try {
      const updatedWorkspace = { ...workspace, title: 'Workspace B' }
      const agent = createAgent({}, async function* (signal) {
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
      }, [workspace, updatedWorkspace], undefined, { reconnectDelay: 25 })
      await agent.connect()
      FakeWebSocket.instances.at(-1)!.close()

      await vi.advanceTimersByTimeAsync(24)
      expect(FakeWebSocket.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeWebSocket.instances).toHaveLength(2)
      const socket = FakeWebSocket.instances.at(-1)
      if (socket === undefined) throw new Error('expected a fake socket')
      expect(socket.sent.map(message => (JSON.parse(message) as { method: string }).method))
        .toEqual(['hub/agent/register'])
      expect(FakeWebSocket.instances.at(-1)!.sent[0]).toContain('Workspace B')
      await agent.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a failed automatic registration and stops retrying after explicit disconnect', async () => {
    vi.useFakeTimers()
    try {
      const agent = createAgent({}, async function* (signal) {
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
      }, [workspace], undefined, { reconnectDelay: 10 })
      await agent.connect()
      FakeWebSocket.registrationFailures = 1
      FakeWebSocket.instances.at(-1)!.close()

      await vi.advanceTimersByTimeAsync(10)
      expect(FakeWebSocket.instances).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(9)
      expect(FakeWebSocket.instances).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeWebSocket.instances).toHaveLength(3)

      FakeWebSocket.instances.at(-1)!.close()
      await agent.disconnect()
      await vi.advanceTimersByTimeAsync(100)
      expect(FakeWebSocket.instances).toHaveLength(3)
    } finally {
      FakeWebSocket.registrationFailures = 0
      vi.useRealTimers()
    }
  })

  it('does not schedule recovery when automatic reconnect is disabled', async () => {
    vi.useFakeTimers()
    try {
      const agent = createAgent({}, async function* (signal) {
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
      }, [workspace], undefined, { autoReconnect: false, reconnectDelay: 1 })
      await agent.connect()
      FakeWebSocket.instances.at(-1)!.close()
      await vi.advanceTimersByTimeAsync(10)
      expect(FakeWebSocket.instances).toHaveLength(1)
      await agent.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not report an abort-driven Host iterator error as a bridge failure', async () => {
    let rejectNext!: (error: Error) => void
    const agent = createAgent({}, _signal => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<{ payload: unknown }>>((_resolve, reject) => { rejectNext = reject }),
        return: async () => ({ done: true, value: undefined }),
      }),
    }))
    await agent.connect()
    const disconnect = agent.disconnect()
    rejectNext(new Error('iterator aborted'))
    await disconnect
    expect(agent.hostStreamFailure).toBeNull()
  })

  it('does not clear a replacement Host bridge from an older bridge completion', async () => {
    let releaseFirst!: () => void
    let calls = 0
    const agent = createAgent({}, async function* (signal) {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return
      }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
    })
    await agent.connect()
    const startHostBridge = (agent as unknown as { startHostBridge: () => void }).startHostBridge
    startHostBridge.call(agent)
    releaseFirst()
    await new Promise(resolve => setTimeout(resolve, 0))
    await agent.disconnect()
  })

  it('rejects duplicate connections and unknown workspace host events', async () => {
    const agent = createAgent()
    await agent.connect()

    await expect(agent.connect()).rejects.toThrow('already connected')
    expect(() => { agent.publishHostEvent('workspace-missing', { type: 'host/session-status' } as never) })
      .toThrow('workspace unavailable')
  })

  it('publishes a fresh authoritative directory after a workspace change', async () => {
    const changedWorkspace = { ...workspace, title: 'Workspace B' }
    const agent = createAgent({}, async function* (signal) {
      yield { payload: { type: 'host/workspace-changed', workspace: { workspaceId: 'workspace-a' } } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }, [workspace, changedWorkspace])
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))

    const socket = FakeWebSocket.instances.at(-1)!
    const messages = socket.sent.map(message => JSON.parse(message) as { method: string; params?: unknown })
    expect(messages.map(message => message.method)).toEqual([
      'hub/agent/register', 'hub/agent/host-event', 'hub/agent/publish-workspaces',
    ])
    expect(messages[1]?.params).toEqual({
      endpointId: 'remote:agent',
      workspaceId: 'workspace-a',
      frame: { type: 'host/workspace-changed', workspace: { workspaceId: 'workspace-a' } },
    })
    expect(messages[2]?.params).toEqual({ workspaces: [{ ...changedWorkspace, endpointId: 'remote:agent' }] })
    await agent.disconnect()
  })

  it('refreshes and forwards a newly discovered workspace change', async () => {
    const discovered = { ...workspace, id: 'workspace-b', title: 'Workspace B' }
    const agent = createAgent({}, async function* (signal) {
      yield { payload: { type: 'host/workspace-changed', workspace: { workspaceId: 'workspace-b' } } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
    }, [workspace, discovered])
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))
    const socket = FakeWebSocket.instances.at(-1)
    if (socket === undefined) throw new Error('expected a fake socket')
    const messages = socket.sent.map(message => JSON.parse(message) as { method: string; params?: Record<string, unknown> })
    expect(messages.at(-2)?.method).toBe('hub/agent/publish-workspaces')
    expect(messages.at(-1)?.params).toMatchObject({ workspaceId: 'workspace-b' })
    await agent.disconnect()
  })

  it('closes the bridge when a session frame has no unique workspace owner', async () => {
    const agent = createAgent({}, async function* () {
      yield { payload: { type: 'host/session-status', sessionId: 'unknown', running: true } }
    })
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(agent.hostStreamFailure).toBeInstanceOf(Error)
    expect((agent.hostStreamFailure as Error).message).toContain('cannot uniquely determine')
    await agent.disconnect()
  })

  it('forwards endpoint-wide frames without assigning a workspace', async () => {
    const agent = createAgent({}, async function* (signal) {
      yield { payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
    })
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))
    const hostMessage = FakeWebSocket.instances.at(-1)!.sent
      .map(message => JSON.parse(message) as { method: string; params?: Record<string, unknown> })
      .find(message => message.method === 'hub/agent/host-event')
    expect(hostMessage?.params?.workspaceId).toBeNull()
    await agent.disconnect()
  })

  it('forwards a workspace removal before removing it from the published directory', async () => {
    const agent = createAgent({}, async function* (signal) {
      yield { payload: { type: 'host/workspace-removed', workspaceId: 'workspace-a' } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }, [workspace, { ...workspace, id: 'workspace-b' }])
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))

    const messages = FakeWebSocket.instances.at(-1)!.sent.map(message => JSON.parse(message) as { method: string; params?: unknown })
    expect(messages.map(message => message.method)).toEqual([
      'hub/agent/register', 'hub/agent/host-event', 'hub/agent/publish-workspaces',
    ])
    expect(messages[1]?.params).toEqual({
      endpointId: 'remote:agent',
      workspaceId: 'workspace-a',
      frame: { type: 'host/workspace-removed', workspaceId: 'workspace-a' },
    })
    expect(messages[2]?.params).toEqual({ workspaces: [{ ...workspace, id: 'workspace-b', endpointId: 'remote:agent' }] })
    await agent.disconnect()
  })

  it('fails the bridge for an unowned non-endpoint frame', async () => {
    const agent = createAgent({}, async function* () {
      yield { payload: { type: 'host/archived-sessions-changed', archivedSessionIds: [] } }
    })
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((agent.hostStreamFailure as Error).message).toContain('cannot determine Host frame workspace')
    await agent.disconnect()
  })

  it('waits for an old Host stream before allowing concurrent reconnects', async () => {
    let release!: () => void
    let calls = 0
    const agent = createAgent({}, async function* (signal) {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => { release = resolve })
        return
      }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () =>{  resolve() }, { once: true }) })
    })
    await agent.connect()
    FakeWebSocket.instances.at(-1)!.close()
    const first = agent.connect()
    const second = agent.connect()
    release()
    await first
    await expect(second).rejects.toThrow('already connected')
    await agent.disconnect()
  })

  it('disconnects when an authoritative directory refresh fails', async () => {
    const directoryError = new Error('directory unavailable')
    const sessionWorkspace = {
      ...workspace,
      sessions: [{ sessionId: 'session-a' as SessionId, updatedAt: 1, running: false, blank: true }],
    }
    let streamSignal: AbortSignal | undefined
    let calls = 0
    const agent = createAgent({}, async function* (signal) {
      streamSignal = signal
      yield { payload: { type: 'host/session-status', sessionId: 'session-a', running: true } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    }, [sessionWorkspace], async () => {
      calls += 1
      if (calls > 1) throw directoryError
      return [sessionWorkspace]
    })
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.hostStreamFailure).toBe(directoryError)
    expect(agent.registrationResult).toBeNull()
    expect(streamSignal?.aborted).toBe(true)
    expect(() =>{  agent.publishHostEvent(null, { type: 'stream/error', error: 'closed' } as never) }).toThrow('not connected')
  })

  it('bridges local Host frames and aborts the stream on disconnect', async () => {
    let aborted = false
    const sessionWorkspace = {
      ...workspace,
      sessions: [{ sessionId: 'session-a' as SessionId, updatedAt: 1, running: false, blank: true }],
    }
    const agent = createAgent({}, async function* (signal) {
      yield { payload: { type: 'host/session-added', sessionId: 'session-a', blank: true, cwd: 'D:/workspace-a' } }
      yield { payload: { type: 'host/session-status', sessionId: 'session-a', running: true } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }) })
    }, [workspace, sessionWorkspace, sessionWorkspace])

    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))
    const socket = FakeWebSocket.instances.at(-1)!
    const hostMessages = socket.sent
      .map(message => JSON.parse(message) as { method: string; params?: Record<string, unknown> })
      .filter(message => message.method === 'hub/agent/host-event')
    expect(hostMessages).toHaveLength(2)
    expect(hostMessages[0]?.params).toMatchObject({ workspaceId: 'workspace-a' })
    expect(hostMessages[1]?.params).toMatchObject({ workspaceId: 'workspace-a', frame: { type: 'host/session-status' } })

    await agent.disconnect()
    expect(aborted).toBe(true)
  })

  it('forwards only session frames from the official mux stream', async () => {
    const agent = createAgent({}, undefined, undefined, undefined, {}, async function* (signal) {
      yield { payload: { type: 'host/ignored', value: true } }
      yield { payload: { type: 'session/event', sessionId: 'unknown', event: { seq: 1 } } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))

    const messages = FakeWebSocket.instances.at(-1)!.sent
      .map(message => JSON.parse(message) as { method: string; params?: Record<string, unknown> })
      .filter(message => message.method === 'hub/agent/event')
    expect(messages).toHaveLength(0)
    expect(agent.hostStreamFailure).toBeInstanceOf(Error)
    expect((agent.hostStreamFailure as Error).message).toContain('session workspace unavailable')
    await agent.disconnect()
  })

  it('forwards a session event with its authoritative workspace owner', async () => {
    const sessionWorkspace = {
      ...workspace,
      sessions: [{ sessionId: 'session-a' as SessionId, updatedAt: 1, running: false, blank: false }],
    }
    const agent = createAgent({}, undefined, [sessionWorkspace], undefined, {}, async function* (signal) {
      yield { payload: { type: 'session/event', sessionId: 'session-a', event: { seq: 1, type: 'assistant/chunk', text: 'hello' } } }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))

    const event = FakeWebSocket.instances.at(-1)!.sent
      .map(message => JSON.parse(message) as { method: string; params?: Record<string, unknown> })
      .find(message => message.method === 'hub/agent/event')
    expect(event?.params).toEqual({
      endpointId: 'remote:agent',
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      event: { seq: 1, type: 'assistant/chunk', text: 'hello' },
    })
    await agent.disconnect()
  })

  it('does not report an abort-driven mux iterator error as a bridge failure', async () => {
    let rejectNext!: (error: Error) => void
    const agent = createAgent({}, undefined, undefined, undefined, {}, _signal => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<{ payload: unknown }>>((_resolve, reject) => { rejectNext = reject }),
        return: async () => ({ done: true, value: undefined }),
      }),
    }))
    await agent.connect()
    const disconnect = agent.disconnect()
    rejectNext(new Error('mux iterator aborted'))
    await disconnect
    expect(agent.hostStreamFailure).toBeNull()
  })

  it('does not clear a replacement mux bridge from an older bridge completion', async () => {
    let releaseFirst!: () => void
    let calls = 0
    const agent = createAgent({}, undefined, undefined, undefined, {}, async function* (signal) {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve })
        return
      }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    })
    await agent.connect()
    const startMuxBridge = (agent as unknown as { startMuxBridge: () => void }).startMuxBridge
    startMuxBridge.call(agent)
    releaseFirst()
    await new Promise(resolve => setTimeout(resolve, 0))
    await agent.disconnect()
  })

  it('closes the connection when the official mux stream fails', async () => {
    const muxError = new Error('mux unavailable')
    const agent = createAgent({}, undefined, undefined, undefined, {}, async function* () {
      throw muxError
    })
    await agent.connect()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agent.hostStreamFailure).toBe(muxError)
    expect(agent.registrationResult).toBeNull()
    await agent.disconnect()
  })

  it('routes allowed API requests and rejects identity, workspace, and method violations', async () => {
    const history = vi.fn(async (request: unknown) => ({ rpcId: 'history', result: { request, ok: true } }))
    const agent = createAgent({ sessions: { history } })
    await agent.connect()
    const handle = agent as unknown as { handleApiRequest: (params: unknown) => Promise<unknown> }

    await expect(handle.handleApiRequest({
      endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'session.history', payload: { sessionId: 's1' },
    })).resolves.toMatchObject({ ok: true })
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: 's1' } }))
    await expect(handle.handleApiRequest({ endpointId: 'remote:other', workspaceId: 'workspace-a', method: 'session.history', payload: {} }))
      .rejects.toThrow('identity mismatch')
    await expect(handle.handleApiRequest({ endpointId: 'remote:agent', workspaceId: 'workspace-missing', method: 'session.history', payload: {} }))
      .rejects.toThrow('workspace unavailable')
    await expect(handle.handleApiRequest({ endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'settings.read', payload: {} }))
      .rejects.toThrow('unsupported Endpoint Agent API method')
    const missingHandlerAgent = createAgent()
    await missingHandlerAgent.connect()
    const missingHandler = missingHandlerAgent as unknown as { handleApiRequest: (params: unknown) => Promise<unknown> }
    await expect(missingHandler.handleApiRequest({ endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'session.history', payload: {} }))
      .rejects.toThrow('unsupported Endpoint Agent API method')
    await missingHandlerAgent.disconnect()

    const subagentList = vi.fn(async () => ({ rpcId: 'subagent-list', result: { ok: true } }))
    const workspaceRename = vi.fn(async () => ({ rpcId: 'workspace-rename', result: { ok: true } }))
    const routedAgent = createAgent({ subagents: { list: subagentList }, workspace: { rename: workspaceRename } })
    await routedAgent.connect()
    const routed = routedAgent as unknown as { handleApiRequest: (params: unknown) => Promise<unknown> }
    await routed.handleApiRequest({ endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'subagent.list', payload: {} })
    await routed.handleApiRequest({ endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'workspace.rename', payload: {} })
    expect(subagentList).toHaveBeenCalledOnce()
    expect(workspaceRename).toHaveBeenCalledOnce()
    await routedAgent.disconnect()

    const disconnected = createAgent()
    const disconnectedPrivate = disconnected as unknown as {
      publishWorkspaces: (workspaces: HubWorkspaceDirectoryEntry[]) => Promise<void>
    }
    await expect(disconnectedPrivate.publishWorkspaces([workspace])).rejects.toThrow('not connected')
  })

  it('validates API requests at the JSON-RPC wire and forwards valid requests', async () => {
    const history = vi.fn(async (request: unknown) => ({ rpcId: 'history', result: { ok: true, request } }))
    const agent = createAgent({ sessions: { history } })
    await agent.connect()
    const socket = FakeWebSocket.instances.at(-1)!

    socket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: 'invalid-request',
      method: 'hub/api/request',
      params: { endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'session.history', payload: [] },
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>).toMatchObject({
      id: 'invalid-request',
      error: { message: 'invalid Endpoint Agent API request' },
    })

    socket.emit('message', JSON.stringify({
      jsonrpc: '2.0',
      id: 'valid-request',
      method: 'hub/api/request',
      params: {
        endpointId: 'remote:agent',
        workspaceId: 'workspace-a',
        method: 'session.history',
        payload: { sessionId: 's1' },
      },
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: 's1' } }))
    expect(JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>).toMatchObject({
      id: 'valid-request',
      result: { ok: true },
    })

    socket.emit('message', JSON.stringify({
      jsonrpc: '2.0', id: 'unknown-method', method: 'hub/unknown', params: {},
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>).toMatchObject({
      id: 'unknown-method', error: { message: 'unknown Endpoint Agent method: hub/unknown' },
    })
  })
})

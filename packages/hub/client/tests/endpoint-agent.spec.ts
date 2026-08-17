import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { HubWorkspaceDirectoryProvider } from '../src/workspace-directory.ts'
import type { HubWorkspaceDirectoryEntry } from '../src/workspace-directory.ts'

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = []
  static behavior: 'open' | 'registration-error' | 'invalid-registration' = 'open'
  readyState = 1
  sent: string[] = []

  constructor(readonly uri: string) {
    super()
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => this.emit('open'))
  }

  send(data: string): void {
    this.sent.push(data)
    const request = JSON.parse(data) as { id: string; method: string }
    if (request.method === 'hub/agent/register' && FakeWebSocket.behavior === 'registration-error') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'registration rejected' },
      })))
      return
    }
    const result = request.method === 'hub/agent/register'
      ? FakeWebSocket.behavior === 'invalid-registration'
        ? { endpointId: 'remote:other', brokerInfo: { name: 'hub', version: '1' } }
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
  snapshot: (() => Promise<HubWorkspaceDirectoryEntry[]>) | undefined = undefined,
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
      },
    } as never,
    directory: {
      snapshot: vi.fn(snapshot ?? (async () => [snapshots[Math.min(snapshotIndex++, snapshots.length - 1)]!])),
    },
  })
}

describe('HubEndpointAgent', () => {
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
    expect(() => agent.publishHostEvent(null, { type: 'stream/error', error: 'closed' } as never)).toThrow('not connected')
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

  it('routes allowed API requests and rejects identity, workspace, and method violations', async () => {
    const history = vi.fn(async (request: unknown) => ({ request, ok: true }))
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
  })

  it('validates API requests at the JSON-RPC wire and forwards valid requests', async () => {
    const history = vi.fn(async (request: unknown) => ({ ok: true, request }))
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
  })
})

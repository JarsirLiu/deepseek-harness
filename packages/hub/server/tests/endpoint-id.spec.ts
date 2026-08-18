import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { HubServer } from '../src/server.ts'

async function* emptyMuxStream(): AsyncGenerator<never> {
  return
}

describe('Hub endpoint identity', () => {
  it('requires start before waiting and supports the persistence list path', async () => {
    const server = new HubServer({
      sessions: { list: () => [{ header: { sessionId: 'memory' } }] },
      get: (key: string) => key === 'sessionPersistence'
        ? { list: async () => [{ sessionId: 'persisted' }] }
        : undefined,
    } as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as {
      waitUntilListening: () => Promise<void>
      handleList: () => Promise<unknown>
    }
    await expect(handle.waitUntilListening()).rejects.toThrow('has not started')
    await expect(handle.handleList()).resolves.toEqual({ sessions: [{ header: { sessionId: 'persisted' } }] })
  })

  it('uses the in-memory session list when persistence is unavailable', async () => {
    const server = new HubServer({
      sessions: { list: () => [{ header: { sessionId: 'memory' } }] },
      get: () => undefined,
    } as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as { handleList: () => Promise<unknown> }
    await expect(handle.handleList()).resolves.toEqual({ sessions: [{ header: { sessionId: 'memory' } }] })
  })

  it('dispatches workspace listing and rejects local API requests without a registry', async () => {
    const server = new HubServer({
      get: (key: string) => key === 'apiProxy' ? {
        sessions: { list: vi.fn(async () => ({ result: { ok: true, value: { items: [] } } })) },
      } : undefined,
    } as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as {
      handleRequest: (client: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>
      handleApiRequest: (params: unknown) => Promise<unknown>
    }
    const client = { authenticated: true, role: 'client' }
    await expect(handle.handleRequest(client, 'hub/workspaces', { workspaces: [] }))
      .resolves.toMatchObject({ endpointId: 'remote:broker' })
    await expect(handle.handleApiRequest({
      endpointId: 'remote:broker', workspaceId: 'workspace-a', method: 'session.history', payload: {},
    })).rejects.toThrow('local workspace registry is unavailable')
  })

  it('rejects an identity that is not an explicit remote endpoint id', () => {
    expect(() => new HubServer({} as never, {
      endpointId: 'configured-client-id' as `remote:${string}`,
    })).toThrow('invalid Hub endpoint identity')
  })

  it('requires an explicit agent token for endpoint registration', async () => {
    const server = new HubServer({} as never, {
      endpointId: 'remote:broker',
      agentTokens: { 'remote:agent': 'secret' },
    })
    type TestClient = {
      authenticated: boolean
      role: 'client'
      endpointId: undefined
    }
    const client: TestClient = {
      authenticated: false,
      role: 'client' as const,
      endpointId: undefined,
    }
    const register = (server as unknown as {
      handleAgentRegister: (client: TestClient, params: unknown) => unknown
    }).handleAgentRegister.bind(server)
    await expect(Promise.resolve().then(() => register(client, {
      endpointId: 'remote:agent', token: 'wrong', serverInfo: { name: 'agent', version: '1' }, workspaces: [],
    }))).rejects.toThrow('endpoint authentication failed')
  })

  it('routes an Agent Host event only to the selected endpoint workspace', () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const agentNotify = vi.fn()
    const clientNotify = vi.fn()
    const agent = {
      role: 'agent' as const,
      endpointId: 'remote:agent' as const,
      workspaces: [
        { endpointId: 'remote:agent', id: 'workspace-a', title: 'A', path: '/a', sessions: [] },
        { endpointId: 'remote:agent', id: 'workspace-b', title: 'B', path: '/b', sessions: [] },
      ],
      transport: { notify: agentNotify },
    }
    const client = {
      role: 'client' as const,
      subscribedWorkspaces: new Map([['remote:agent', new Set(['workspace-a'])]]),
      transport: { notify: clientNotify },
    }
    const handle = server as unknown as {
      handleAgentHostEvent: (record: unknown, params: unknown) => void
    }
    const clients = server as unknown as { clients: Map<string, unknown> }
    clients.clients.set('client', client)
    handle.handleAgentHostEvent(agent, {
      endpointId: 'remote:agent',
      workspaceId: 'workspace-a',
      frame: { type: 'host/session-status', sessionId: 's1', running: true },
    })
    handle.handleAgentHostEvent(agent, {
      endpointId: 'remote:agent',
      workspaceId: 'workspace-b',
      frame: { type: 'host/session-status', sessionId: 's2', running: true },
    })
    handle.handleAgentHostEvent(agent, {
      endpointId: 'remote:agent',
      workspaceId: null,
      frame: { type: 'host/remote-event', event: 'settings/document-updated', args: [] },
    })
    expect(clientNotify).toHaveBeenCalledTimes(2)
    expect(clientNotify).toHaveBeenCalledWith('hub/host', expect.objectContaining({ endpointId: 'remote:agent', workspaceId: 'workspace-a' }))
    expect(clientNotify).toHaveBeenCalledWith('hub/host', expect.objectContaining({ endpointId: 'remote:agent', workspaceId: null }))
    expect(agentNotify).not.toHaveBeenCalled()
  })

  it('rejects endpoint discovery when an Agent has no server metadata', () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const clients = server as unknown as { clients: Map<string, unknown> }
    clients.clients.set('agent', { role: 'agent', endpointId: 'remote:agent', workspaces: [] })
    const handle = server as unknown as { handleListEndpoints: (client: unknown) => unknown }
    expect(() => handle.handleListEndpoints({ role: 'client', authenticated: true }))
      .toThrow('missing server info')
  })

  it('routes local API requests only after validating the local workspace', async () => {
    const history = vi.fn(async (request: unknown) => ({ rpcId: 'history', result: { source: 'local', request } }))
    const server = new HubServer({
      get: (key: string) => key === 'workspaceRegistry'
        ? { list: () => [{ id: 'workspace-a' }] }
        : key === 'apiProxy' ? { sessions: { history } } : undefined,
    } as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as { handleApiRequest: (params: unknown) => Promise<unknown> }

    await expect(handle.handleApiRequest({
      endpointId: 'remote:broker', workspaceId: 'workspace-a', method: 'session.history', payload: { sessionId: 's1' },
    })).resolves.toMatchObject({ source: 'local' })
    await expect(handle.handleApiRequest({
      endpointId: 'remote:broker', workspaceId: 'workspace-missing', method: 'session.history', payload: {},
    })).rejects.toThrow('local workspace unavailable')
    await expect(handle.handleApiRequest({
      endpointId: 'remote:broker', workspaceId: 'workspace-a', method: 'settings.read', payload: {},
    })).rejects.toThrow('unsupported remote API method')
  })

  it('routes remote API requests to the matching Agent and rejects unknown workspaces', async () => {
    const request = vi.fn(async (_method: string, params: unknown) => ({ source: 'agent', params }))
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const clients = server as unknown as { clients: Map<string, unknown> }
    clients.clients.set('agent', {
      role: 'agent',
      endpointId: 'remote:agent',
      workspaces: [{ endpointId: 'remote:agent', id: 'workspace-a', title: 'A', path: '/a', sessions: [] }],
      transport: { request },
    })
    const handle = server as unknown as { handleApiRequest: (params: unknown) => Promise<unknown> }

    await expect(handle.handleApiRequest({
      endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'session.history', payload: { sessionId: 's1' },
    })).resolves.toMatchObject({ source: 'agent' })
    expect(request).toHaveBeenCalledWith('hub/api/request', expect.objectContaining({ workspaceId: 'workspace-a' }))
    await expect(handle.handleApiRequest({
      endpointId: 'remote:agent', workspaceId: 'workspace-missing', method: 'session.history', payload: {},
    })).rejects.toThrow('remote workspace unavailable')
    await expect(handle.handleApiRequest({
      endpointId: 'remote:missing', workspaceId: 'workspace-a', method: 'session.history', payload: {},
    })).rejects.toThrow('remote endpoint unavailable')
  })

  it('keeps session subscriptions isolated by workspace', () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const notify = vi.fn()
    const client = {
      subscribedAll: false,
      subscribedSessions: new Set<string>(),
      transport: { notify, close: vi.fn() },
      socket: { close: vi.fn() },
    }
    const handle = server as unknown as {
      handleSubscribe: (client: unknown, params: unknown) => unknown
      broadcastToSubscribers: (workspaceId: string, sessionId: string, method: string, notification: unknown) => void
    }
    const clients = server as unknown as { clients: Map<string, unknown> }
    clients.clients.set('client', client)

    handle.handleSubscribe(client, { id: 'shared-session', workspaceId: 'workspace-a' })
    handle.broadcastToSubscribers('workspace-a', 'shared-session', 'hub/event', { workspaceId: 'workspace-a' })
    handle.broadcastToSubscribers('workspace-b', 'shared-session', 'hub/event', { workspaceId: 'workspace-b' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('hub/event', { workspaceId: 'workspace-a' })
  })

  it('enforces authentication before dispatching protected requests', async () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker', authTokens: ['secret'] })
    const handle = server as unknown as {
      handleRequest: (client: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>
    }
    const client = { authenticated: false, role: 'client' }

    await expect(handle.handleRequest(client, 'hub/list-endpoints', {})).rejects.toThrow('handshake required')
    await expect(handle.handleRequest(client, 'hub/subscribe-workspaces', { workspaces: [] })).rejects.toThrow('handshake required')
  })

  it('rejects malformed API, workspace subscription, and Agent publish payloads', async () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as {
      handleRequest: (client: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>
    }
    const client = { authenticated: true, role: 'client' }

    await expect(handle.handleRequest(client, 'hub/api/request', { endpointId: 'remote:broker' }))
      .rejects.toThrow('invalid Hub API request')
    await expect(handle.handleRequest(client, 'hub/subscribe-workspaces', { workspaces: [{ endpointId: 'remote:broker' }] }))
      .rejects.toThrow('invalid Hub workspace subscription')
    await expect(handle.handleRequest(client, 'hub/agent/publish-workspaces', { workspaces: {} }))
      .rejects.toThrow('invalid Endpoint Agent workspace directory')
  })

  it('rejects malformed Agent session event notifications without stopping the Hub', async () => {
    const server = new HubServer({ logger: { warn: vi.fn() } } as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as {
      handleConnection: (socket: unknown) => void
    }
    const socket = Object.assign(new EventEmitter(), { close: vi.fn(), send: vi.fn() })
    handle.handleConnection(socket)
    socket.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'hub/agent/event', params: {
      endpointId: 'remote:agent', workspaceId: 'workspace-a',
    } }))
    expect(socket.close).toHaveBeenCalledOnce()
    expect((server as unknown as { clients: Map<unknown, unknown> }).clients.size).toBe(1)
  })

  it('requires workspace ownership for session subscriptions', async () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as {
      handleRequest: (client: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>
    }
    const client = { authenticated: true, role: 'client' }

    await expect(handle.handleRequest(client, 'hub/subscribe', { id: 'session-a' }))
      .rejects.toThrow('workspaceId is required')
    await expect(handle.handleRequest(client, 'hub/unsubscribe', { id: 'session-a' }))
      .rejects.toThrow('workspaceId is required')
  })

  it('composes selected local and Agent workspaces while removing archived sessions', async () => {
    const workspaceRegistry = {
      list: () => [{ id: 'local-a', title: 'Local A', path: 'D:/local-a', sessionIds: ['s1', 's2', 's3'] }],
      archivedSessionIds: ['s3'],
    }
    const apiProxy = {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [
          { sessionId: 's1', updatedAt: 1, running: false, blank: false, projections: { values: { title: 'Direct title' } } },
          { sessionId: 's2', updatedAt: 2, running: true, blank: false },
        ] } } }),
        history: async () => ({ result: { ok: true, value: { projections: { values: { title: 'History title' } } } } }),
      },
    }
    const server = new HubServer({
      get: (key: string) => key === 'workspaceRegistry' ? workspaceRegistry
        : key === 'apiProxy' ? apiProxy : undefined,
    } as never, { endpointId: 'remote:broker' })
    const clients = server as unknown as { clients: Map<string, unknown> }
    clients.clients.set('agent', {
      role: 'agent',
      endpointId: 'remote:agent',
      workspaces: [{ endpointId: 'remote:agent', id: 'remote-a', title: 'Remote A', path: 'D:/remote-a', sessions: [
        { endpointId: 'remote:agent', sessionId: 'remote-s1', updatedAt: 3, running: false, blank: true },
      ] }],
    })
    type WorkspaceResult = { workspaces: Array<{ id: string; sessions: Array<{ sessionId: string; title?: string }> }> }
    const handle = server as unknown as { handleWorkspaces: (params: unknown) => Promise<WorkspaceResult> }

    await expect(handle.handleWorkspaces({ workspaces: [
      { endpointId: 'remote:broker', workspaceId: 'local-a' },
      { endpointId: 'remote:agent', workspaceId: 'remote-a' },
    ] })).resolves.toEqual({
      endpointId: 'remote:broker',
      workspaces: [
        {
          endpointId: 'remote:broker', id: 'local-a', title: 'Local A', path: 'D:/local-a',
          sessions: [
            expect.objectContaining({ sessionId: 's1', title: 'Direct title' }),
            expect.objectContaining({ sessionId: 's2', title: 'History title' }),
          ],
        },
        {
          endpointId: 'remote:agent', id: 'remote-a', title: 'Remote A', path: 'D:/remote-a',
          sessions: [expect.objectContaining({ sessionId: 'remote-s1' })],
        },
      ],
    })
  })

  it('completes authenticated handshake and Agent registration state transitions', () => {
    const host = async function* (): AsyncGenerator<never> { return }
    const server = new HubServer({
      get: (key: string) => key === 'apiProxy' ? { events: { host, mux: emptyMuxStream } } : undefined,
    } as never, {
      endpointId: 'remote:broker',
      authTokens: ['client-secret'],
      agentTokens: { 'remote:agent': 'agent-secret' },
    })
    const handle = server as unknown as {
      handleHandshake: (client: unknown, params: unknown) => unknown
      handleAgentRegister: (client: unknown, params: unknown) => unknown
    }
    const client = { authenticated: false, role: 'client', subscribedWorkspaces: new Map() }
    expect(handle.handleHandshake(client, { token: 'client-secret' })).toMatchObject({
      endpointId: 'remote:broker', capabilities: { subscriptions: true, delete: false },
    })
    expect(client.authenticated).toBe(true)

    const agent = { authenticated: false, role: 'client', endpointId: undefined }
    expect(handle.handleAgentRegister(agent, {
      endpointId: 'remote:agent', token: 'agent-secret', serverInfo: { name: 'agent', version: '1' }, workspaces: [],
    })).toMatchObject({ endpointId: 'remote:agent' })
    expect(agent).toMatchObject({ authenticated: true, role: 'agent', endpointId: 'remote:agent' })
  })

  it('publishes updated Agent workspaces and rejects duplicate registrations', () => {
    const server = new HubServer({} as never, {
      endpointId: 'remote:broker',
      agentTokens: { 'remote:agent': 'agent-secret' },
    })
    const handle = server as unknown as {
      handleAgentRegister: (client: unknown, params: unknown) => unknown
      handleAgentPublishWorkspaces: (client: unknown, params: unknown) => unknown
      handleListEndpoints: (client: unknown) => unknown
    }
    const agent = { authenticated: false, role: 'client', endpointId: undefined as undefined }
    const params = {
      endpointId: 'remote:agent', token: 'agent-secret',
      serverInfo: { name: 'agent', version: '1' }, workspaces: [],
    }
    handle.handleAgentRegister(agent, params)
    ;(server as unknown as { clients: Map<string, unknown> }).clients.set('agent', agent)
    expect(handle.handleAgentPublishWorkspaces(agent, { workspaces: [] })).toEqual({})
    expect(handle.handleListEndpoints({ role: 'client', authenticated: true })).toMatchObject({
      endpoints: [{ endpointId: 'remote:broker' }, { endpointId: 'remote:agent', workspaces: [] }],
    })
    const second = { authenticated: false, role: 'client', endpointId: undefined as undefined }
    expect(() => handle.handleAgentRegister(second, params)).toThrow('endpoint already connected')
    expect(() => handle.handleAgentPublishWorkspaces({ role: 'client' }, { workspaces: [] }))
      .toThrow('Endpoint Agent registration required')
  })

  it('rejects role changes and endpoint discovery from Agent connections', () => {
    const server = new HubServer({} as never, {
      endpointId: 'remote:broker',
      agentTokens: { 'remote:agent': 'agent-secret' },
    })
    const handle = server as unknown as {
      handleAgentRegister: (client: unknown, params: unknown) => unknown
      handleListEndpoints: (client: unknown) => unknown
    }
    const registered = { authenticated: true, role: 'client', endpointId: 'remote:existing' }
    expect(() => handle.handleAgentRegister(registered, {
      endpointId: 'remote:agent', token: 'agent-secret',
      serverInfo: { name: 'agent', version: '1' }, workspaces: [],
    })).toThrow('connection already registered')
    expect(() => handle.handleListEndpoints({ role: 'agent', authenticated: true }))
      .toThrow('authenticated Client required')
    expect(() => handle.handleListEndpoints({ role: 'client', authenticated: false }))
      .toThrow('authenticated Client required')
  })

  it('rejects Agent notifications whose endpoint identity does not match the connection', () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as {
      handleAgentHostEvent: (client: unknown, params: unknown) => void
      handleAgentEvent: (client: unknown, params: unknown) => void
    }
    const client = { role: 'client', endpointId: undefined }
    expect(() => handle.handleAgentHostEvent(client, {
      endpointId: 'remote:agent', workspaceId: null, frame: { type: 'host/session-status' },
    })).toThrow('Endpoint Agent registration required')
    expect(() => handle.handleAgentEvent(client, {
      endpointId: 'remote:agent', workspaceId: 'workspace-a', sessionId: 'session-a', event: { type: 'x' },
    })).toThrow('Endpoint Agent registration required')
  })

  it('validates Agent host and session events before forwarding them', () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const notify = vi.fn()
    const agent = {
      role: 'agent', endpointId: 'remote:agent',
      workspaces: [{ endpointId: 'remote:agent', id: 'workspace-a', title: 'A', path: '/a', sessions: [
        { endpointId: 'remote:agent', sessionId: 'session-a', updatedAt: 1, running: false, blank: false },
      ] }],
      transport: { notify },
    }
    const target = {
      role: 'client', subscribedWorkspaces: new Map([['remote:agent', new Set(['workspace-a'])]]),
      transport: { notify },
    }
    const clients = server as unknown as { clients: Map<string, unknown> }
    clients.clients.set('target', target)
    const handle = server as unknown as {
      handleAgentHostEvent: (client: unknown, params: unknown) => void
      handleAgentEvent: (client: unknown, params: unknown) => void
    }
    handle.handleAgentHostEvent(agent, {
      endpointId: 'remote:agent', workspaceId: 'workspace-a',
      frame: { type: 'host/session-status', sessionId: 'session-a', running: true },
    })
    handle.handleAgentEvent(agent, {
      endpointId: 'remote:agent', workspaceId: 'workspace-a', sessionId: 'session-a',
      event: { type: 'assistant/chunk', content: 'ok' },
    })
    expect(notify).toHaveBeenCalledWith('hub/host', expect.objectContaining({ workspaceId: 'workspace-a' }))
    expect(notify).toHaveBeenCalledWith('hub/event', expect.objectContaining({ sessionId: 'session-a' }))
    expect(() => handle.handleAgentHostEvent(agent, {
      endpointId: 'remote:agent', workspaceId: 'missing', frame: { type: 'host/session-status' },
    })).toThrow('remote workspace unavailable')
    expect(() => handle.handleAgentEvent(agent, {
      endpointId: 'remote:agent', workspaceId: 'workspace-a', sessionId: 'missing', event: { type: 'x' },
    })).toThrow('remote session unavailable')
  })

  it('supports workspace filters and removes session subscriptions', () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const client = {
      subscribedWorkspaces: new Map(), subscribedSessions: new Set<string>(), subscribedAll: false,
    }
    const handle = server as unknown as {
      handleWorkspaceSubscription: (client: unknown, params: unknown) => unknown
      handleSubscribe: (client: unknown, params: unknown) => unknown
      handleUnsubscribe: (client: unknown, params: unknown) => unknown
    }
    expect(handle.handleWorkspaceSubscription(client, {
      workspaces: [{ endpointId: 'remote:agent', workspaceId: 'workspace-a' }],
    })).toEqual({})
    expect(client.subscribedWorkspaces.get('remote:agent')).toEqual(new Set(['workspace-a']))
    handle.handleSubscribe(client, { id: 'session-a', workspaceId: 'workspace-a' })
    handle.handleUnsubscribe(client, { id: 'session-a', workspaceId: 'workspace-a' })
    expect(client.subscribedSessions.size).toBe(0)
    handle.handleSubscribe(client, {})
    handle.handleUnsubscribe(client, {})
    expect(client.subscribedAll).toBe(false)
  })

  it('ignores host frames outside the selected local workspace and tolerates notify failures', () => {
    const server = new HubServer({
      get: (key: string) => key === 'workspaceRegistry'
        ? { list: () => [{ id: 'workspace-a', sessionIds: ['session-a'] }] }
        : undefined,
    } as never, { endpointId: 'remote:broker' })
    const notify = vi.fn(() => { throw new Error('socket closed') })
    const clients = server as unknown as { clients: Map<string, unknown> }
    clients.clients.set('client', {
      subscribedWorkspaces: new Map([['remote:broker', new Set(['workspace-a'])]]),
      transport: { notify },
    })
    const handle = server as unknown as { broadcastHostNotification: (notification: unknown) => void }
    handle.broadcastHostNotification({ endpointId: 'remote:broker', workspaceId: 'workspace-a', frame: { type: 'host/session-status' } })
    handle.broadcastHostNotification({ endpointId: 'remote:broker', workspaceId: 'workspace-missing', frame: { type: 'host/session-status' } })
    expect(notify).toHaveBeenCalledOnce()
  })

  it('rejects malformed wire payloads at every Agent parser branch', async () => {
    const server = new HubServer({} as never, { endpointId: 'remote:broker' })
    const handle = server as unknown as {
      handleRequest: (client: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>
    }
    const client = { authenticated: true, role: 'client' }
    const expectInvalid = async (method: string, params: Record<string, unknown>, message: string): Promise<void> => {
      await expect(handle.handleRequest(client, method, params)).rejects.toThrow(message)
    }

    for (const params of [
      {},
      { endpointId: 'broker', token: 'x', serverInfo: { name: 'n', version: 'v' }, workspaces: [] },
      { endpointId: 'remote:a', token: '', serverInfo: { name: 'n', version: 'v' }, workspaces: [] },
      { endpointId: 'remote:a', token: 'x', serverInfo: {}, workspaces: [] },
      { endpointId: 'remote:a', token: 'x', serverInfo: { name: 'n' }, workspaces: [] },
    ]) await expectInvalid('hub/agent/register', params, 'invalid Endpoint Agent registration')
    await expectInvalid('hub/agent/register', {
      endpointId: 'remote:a', token: 'x', serverInfo: { name: 'n', version: 'v' }, workspaces: {},
    }, 'invalid Endpoint Agent workspace directory')

    for (const params of [{}, { workspaces: {} }, { workspaces: [null] }, {
      workspaces: [{ endpointId: 'remote:a', id: 'w', title: 'W', path: '/w', sessions: [{}] }],
    }, {
      workspaces: [{ endpointId: 'remote:a', id: 'w', title: 'W', path: '/w', sessions: [{
        endpointId: 'remote:a', sessionId: 's', updatedAt: Infinity, running: false, blank: false,
      }] }],
    }]) await expectInvalid('hub/agent/publish-workspaces', params, 'invalid Endpoint Agent workspace directory')

    for (const params of [
      { workspaces: [{}] },
      { workspaces: [{ endpointId: 'broker', workspaceId: 'w' }] },
      { workspaces: [{ endpointId: 'remote:a', workspaceId: '' }] },
      { workspaces: [{ endpointId: 'remote:a' }] },
    ]) await expectInvalid('hub/subscribe-workspaces', params, 'invalid Hub workspace subscription')

  })

  it('drops session lifecycle events without an owning workspace', async () => {
    const listeners = new Map<string, (value: never, event?: never) => void>()
    const server = new HubServer({
      logger: { info: vi.fn() },
      on: vi.fn((event: string, listener: (value: never, event?: never) => void) => {
        listeners.set(event, listener)
        return vi.fn()
      }),
      get: (key: string) => key === 'workspaceRegistry' ? { list: () => [] } : undefined,
    } as never, { endpointId: 'remote:broker', port: 0 })
    const notify = vi.fn()
    const clients = server as unknown as { clients: Map<string, unknown> }
    clients.clients.set('client', {
      subscribedAll: true,
      subscribedSessions: new Set(),
      transport: { notify, close: vi.fn() },
      socket: { close: vi.fn() },
    })

    server.start()
    listeners.get('session/created')!({ id: 'orphan' } as never)
    listeners.get('session/disposed')!({ id: 'orphan' } as never)

    expect(notify).not.toHaveBeenCalled()
    await server.stop()
  })

  it('ignores subscriber notification failures and avoids starting a duplicate Host stream', async () => {
    let hostCalls = 0
    const host = vi.fn(async function* (_request: unknown, signal: AbortSignal) {
      hostCalls++
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const server = new HubServer({
      get: (key: string) => key === 'apiProxy' ? { events: { host, mux: emptyMuxStream } } : undefined,
    } as never, { endpointId: 'remote:broker', port: 0 })
    const client = {
      subscribedAll: true,
      subscribedSessions: new Set(),
      transport: { notify: vi.fn(() => { throw new Error('closed') }), close: vi.fn() },
      socket: { close: vi.fn() },
    }
    const handle = server as unknown as {
      clients: Map<string, unknown>
      broadcastToSubscribers: (workspaceId: string, sessionId: string, method: string, notification: unknown) => void
      startHostStream: (client: unknown) => void
    }
    handle.clients.set('client', client)
    handle.broadcastToSubscribers('workspace-a', 'session-a', 'hub/event', {})
    handle.startHostStream(client)
    handle.startHostStream(client)
    await vi.waitFor(() => expect(hostCalls).toBe(1))
    expect(client.transport.notify).toHaveBeenCalledTimes(1)
    await server.stop()
  })

  it('filters unrelated Host frames and forwards endpoint-wide frames', async () => {
    const host = vi.fn(async function* () {
      yield { payload: { type: 'host/session-status', sessionId: 'session-other', running: true } as never }
      yield { payload: { type: 'host/remote-event', event: 'settings/document-updated', args: [] } as never }
    })
    const server = new HubServer({
      get: (key: string) => key === 'workspaceRegistry'
        ? { list: () => [{ id: 'workspace-a', sessionIds: ['session-a'] }, { id: 'workspace-b', sessionIds: ['session-other'] }] }
        : key === 'apiProxy' ? { events: { host, mux: emptyMuxStream } } : undefined,
    } as never, { endpointId: 'remote:broker', port: 0 })
    const notifications: unknown[] = []
    const client = {
      subscribedWorkspaces: new Map([['remote:broker', new Set(['workspace-a'])]]),
      transport: { notify: vi.fn((_method: string, params: unknown) => { notifications.push(params) }), close: vi.fn() },
      socket: { close: vi.fn() },
    }
    const handle = server as unknown as { startHostStream: (client: unknown) => void; clients: Map<string, unknown> }
    handle.clients.set('client', client)
    handle.startHostStream(client)
    await vi.waitFor(() => expect(notifications).toHaveLength(1))
    expect(notifications[0]).toEqual({
      endpointId: 'remote:broker', workspaceId: null,
      frame: { type: 'host/remote-event', event: 'settings/document-updated', args: [] },
    })
    await server.stop()
  })
})

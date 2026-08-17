import { describe, expect, it, vi } from 'vitest'
import { HubServer } from '../src/server.ts'

describe('Hub endpoint identity', () => {
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
    expect(clientNotify).toHaveBeenCalledTimes(1)
    expect(clientNotify).toHaveBeenCalledWith('hub/host', expect.objectContaining({ endpointId: 'remote:agent', workspaceId: 'workspace-a' }))
    expect(agentNotify).not.toHaveBeenCalled()
  })

  it('routes local API requests only after validating the local workspace', async () => {
    const history = vi.fn(async (request: unknown) => ({ source: 'local', request }))
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
      transport: { notify },
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
      get: (key: string) => key === 'apiProxy' ? { events: { host } } : undefined,
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
})

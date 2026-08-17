/**
 * WebSocket JSON-RPC hub server: accepts remote client connections and
 * proxies session operations to the local SessionStore and SessionPersistence.
 *
 * @module @deepseek-ai/dsh-hub-server/server
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { WebSocketServer, type WebSocket } from 'ws'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { hostFrameWorkspaceIds, isHostFrameVisibleToWorkspaces, type WorkspaceSubscriptionEntry } from './workspace-subscription.ts'
export { hostFrameWorkspaceIds, isHostFrameVisibleToWorkspaces } from './workspace-subscription.ts'
import {
  JsonRpcWebSocketTransport,
  type HubHandshakeParams,
  type HubHandshakeResult,
  type HubCapabilities,
  type HubAgentRegisterParams,
  type HubAgentHostEventParams,
  type HubApiRequestParams,
  type HubEndpointSummary,
  type HubWorkspaceEntry,
  type HubEventNotification,
  type HubHostNotification,
  type HubStatusNotification,
  type HubWorkspaceRef,
} from '@deepseek-ai/dsh-hub-protocol'

/** A connected client session record. */
interface ClientRecord {
  id: string
  socket: WebSocket
  transport: JsonRpcWebSocketTransport
  subscribedSessions: Set<string>
  subscribedAll: boolean
  subscribedWorkspaces: Map<`remote:${string}`, Set<string>>
  authenticated: boolean
  role: 'client' | 'agent'
  endpointId?: `remote:${string}`
  serverInfo?: { name: string; version: string }
  workspaces?: HubWorkspaceEntry[]
  hostAbortController?: AbortController
}

/**
 * Hub server configuration.
 */
export interface HubServerConfig {
  /** Stable identity exposed to clients for this Hub endpoint. */
  endpointId: `remote:${string}`
  /** TCP port to listen on. Defaults to 8765. */
  port?: number
  /** Host to bind to. Defaults to '0.0.0.0'. */
  host?: string
  /** Optional set of authentication tokens. */
  authTokens?: string[]
  /** Endpoint-to-Hub credentials for Endpoint Agents. */
  agentTokens?: Record<string, string>
  /** Server identity name. */
  serverName?: string
  /** Remote preset selected for each published workspace, keyed by workspace id. */
  workspacePresets?: Record<string, string>
}

const DEFAULTS = {
  port: 8765,
  host: '127.0.0.1',
  serverName: 'deepseek-harness-hub',
  version: '0.1.0',
}

/**
 * Hub server that exposes local harness sessions to remote clients via
 * WebSocket JSON-RPC.
 */
export class HubServer {
  private readonly httpServer = createServer()
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly clients = new Map<string, ClientRecord>()
  private readonly eventDisposers: Array<() => void> = []
  private readonly config: Required<HubServerConfig>
  private started = false
  private listeningPromise: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    config: HubServerConfig,
  ) {
    this.config = {
      endpointId: requireEndpointId(config.endpointId),
      port: config.port ?? DEFAULTS.port,
      host: config.host ?? DEFAULTS.host,
      authTokens: config.authTokens ?? [],
      agentTokens: config.agentTokens ?? {},
      serverName: config.serverName ?? DEFAULTS.serverName,
      workspacePresets: config.workspacePresets ?? {},
    }

    // Handle WebSocket upgrade requests.
    this.httpServer.on('upgrade', (req, socket, head) => {
      // Only accept /hub path.
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (url.pathname !== '/hub') {
        socket.destroy()
        return
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws)
      })
    })
  }

  /** Start the HTTP server and begin accepting connections. */
  start(): void {
    if (this.started) return
    this.started = true
    this.listeningPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.httpServer.off('error', onError)
        resolve()
      }
      this.httpServer.once('error', onError)
      this.httpServer.once('listening', onListening)
      this.httpServer.listen(this.config.port, this.config.host)
    })
    this.ctx.logger.info(`hub server listening on ${this.config.host}:${this.config.port}`)

    // Subscribe to session events for forwarding to subscribed clients.
    this.eventDisposers.push(this.ctx.on('session/event', (_session, event) => {
      const sessionId = _session.id
      const workspaceId = this.workspaceForSession(sessionId)
      if (workspaceId === undefined) return
      const notification: HubEventNotification = { endpointId: this.config.endpointId, workspaceId, sessionId, event }
      this.broadcastToSubscribers(workspaceId, sessionId, 'hub/event', notification)
    }))

    // Subscribe to session lifecycle events.
    this.eventDisposers.push(this.ctx.on('session/created', (session) => {
      const workspaceId = this.workspaceForSession(session.id)
      if (workspaceId === undefined) return
      const notification: HubStatusNotification = {
        endpointId: this.config.endpointId,
        workspaceId,
        sessionId: session.id,
        status: 'created',
      }
      this.broadcastToSubscribers(notification.workspaceId, session.id, 'hub/status', notification)
    }))

    this.eventDisposers.push(this.ctx.on('session/disposed', (session) => {
      const workspaceId = this.workspaceForSession(session.id)
      if (workspaceId === undefined) return
      const notification: HubStatusNotification = {
        endpointId: this.config.endpointId,
        workspaceId,
        sessionId: session.id,
        status: 'disposed',
      }
      this.broadcastToSubscribers(notification.workspaceId, session.id, 'hub/status', notification)
    }))
  }

  /** Wait until the configured listener has accepted its bind request. */
  async waitUntilListening(): Promise<void> {
    if (!this.listeningPromise) throw new Error('hub server has not started')
    await this.listeningPromise
  }

  /** Stop the server and close all connections. */
  async stop(): Promise<void> {
    for (const dispose of this.eventDisposers.splice(0)) dispose()
    for (const [id, client] of this.clients) {
      client.hostAbortController?.abort()
      client.transport.close()
      client.socket.close()
      this.clients.delete(id)
    }
    this.wss.close()
    return new Promise((resolve) => {
      this.httpServer.close(() => { resolve() })
    })
  }

  private handleConnection(ws: WebSocket): void {
    const transport = new JsonRpcWebSocketTransport(ws)
    const clientId = `client_${randomUUID().replaceAll('-', '')}`
    const client: ClientRecord = {
      id: clientId,
      socket: ws,
      transport,
      subscribedSessions: new Set(),
      subscribedAll: false,
      subscribedWorkspaces: new Map(),
      authenticated: this.config.authTokens.length === 0,
      role: 'client',
    }
    this.clients.set(clientId, client)

    transport.onRequest(async (method, params) => {
      return this.handleRequest(client, method, params)
    })
    transport.onNotification((method, params) => {
      if (method === 'hub/agent/host-event') this.handleAgentHostEvent(client, parseAgentHostEventParams(params))
    })

    transport.start()

    ws.on('close', () => {
      client.hostAbortController?.abort()
      transport.close()
      this.clients.delete(clientId)
    })
  }

  private async handleRequest(
    client: ClientRecord,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== 'hub/handshake' && method !== 'hub/agent/register' && !client.authenticated) {
      throw new Error('handshake required')
    }
    switch (method) {
      case 'hub/handshake':
        return this.handleHandshake(client, params)
      case 'hub/agent/register':
        return this.handleAgentRegister(client, parseAgentRegisterParams(params))
      case 'hub/agent/publish-workspaces':
        return this.handleAgentPublishWorkspaces(client, parseWorkspacePublishParams(params))
      case 'hub/list':
        return this.handleList()
      case 'hub/list-endpoints':
        return this.handleListEndpoints(client)
      case 'hub/workspaces':
        return await this.handleWorkspaces(parseWorkspaceSubscriptionParams(params))
      case 'hub/api/request':
        return await this.handleApiRequest(parseApiRequestParams(params))
      case 'hub/subscribe':
        return this.handleSubscribe(client, params)
      case 'hub/unsubscribe':
        return this.handleUnsubscribe(client, params)
      case 'hub/subscribe-workspaces':
        return this.handleWorkspaceSubscription(client, parseWorkspaceSubscriptionParams(params))
      default:
        throw new Error(`unknown hub method: ${method}`)
    }
  }

  private handleHandshake(client: ClientRecord, params: HubHandshakeParams): HubHandshakeResult {
    // Validate auth token.
    if (this.config.authTokens.length > 0) {
      if (!params.token || !this.config.authTokens.includes(params.token)) {
        throw new Error('authentication failed')
      }
    }
    client.authenticated = true
    this.startHostStream(client)

    const capabilities: HubCapabilities = {
      subscriptions: true,
      delete: false,
    }

    return {
      endpointId: this.config.endpointId,
      serverInfo: {
        name: this.config.serverName,
        version: DEFAULTS.version,
      },
      capabilities,
    }
  }

  private handleAgentRegister(client: ClientRecord, params: HubAgentRegisterParams): { endpointId: `remote:${string}`; brokerInfo: { name: string; version: string } } {
    if (client.role !== 'client' || client.endpointId !== undefined) throw new Error('connection already registered')
    requireEndpointId(params.endpointId)
    const expected = this.config.agentTokens[params.endpointId]
    if (expected === undefined || params.token !== expected) throw new Error('endpoint authentication failed')
    for (const existing of this.clients.values()) {
      if (existing !== client && existing.role === 'agent' && existing.endpointId === params.endpointId) {
        throw new Error(`endpoint already connected: ${params.endpointId}`)
      }
    }
    client.authenticated = true
    client.role = 'agent'
    client.endpointId = params.endpointId
    client.serverInfo = params.serverInfo
    client.workspaces = params.workspaces
    return {
      endpointId: params.endpointId,
      brokerInfo: { name: this.config.serverName, version: DEFAULTS.version },
    }
  }

  private handleAgentPublishWorkspaces(client: ClientRecord, params: { workspaces: HubWorkspaceEntry[] }): Record<string, never> {
    if (client.role !== 'agent' || client.endpointId === undefined) throw new Error('Endpoint Agent registration required')
    client.workspaces = params.workspaces
    return {}
  }

  private handleListEndpoints(client: ClientRecord): { endpoints: HubEndpointSummary[] } {
    if (client.role !== 'client' || !client.authenticated) throw new Error('authenticated Client required')
    const endpoints: HubEndpointSummary[] = [{
      endpointId: this.config.endpointId,
      serverInfo: { name: this.config.serverName, version: DEFAULTS.version },
      workspaces: [],
    }]
    for (const client of this.clients.values()) {
      if (client.role !== 'agent' || client.endpointId === undefined || client.workspaces === undefined) continue
      if (client.serverInfo === undefined) throw new Error(`registered Agent is missing server info: ${client.endpointId}`)
      endpoints.push({
        endpointId: client.endpointId,
        serverInfo: client.serverInfo,
        workspaces: client.workspaces,
      })
    }
    return { endpoints }
  }

  /** Forward the official api.events.host stream without changing its frames. */
  private startHostStream(client: ClientRecord): void {
    if (client.hostAbortController !== undefined) return
    const api = this.ctx.get('apiProxy') as {
      events?: {
        host: (request: { rpcId: string; payload: Record<string, never> }, signal: AbortSignal) => AsyncIterable<{ payload: import('@deepseek-ai/dsh-host-apiproxy/api').HostFrame }>
      }
    } | undefined
    const host = api?.events?.host
    if (host === undefined) throw new Error('remote host event API is unavailable')
    const controller = new AbortController()
    client.hostAbortController = controller
    void (async () => {
      try {
        for await (const envelope of host({ rpcId: `hub-host-${randomUUID()}`, payload: {} }, controller.signal)) {
          const workspaces = this.workspaceEntries()
          if (!isHostFrameVisibleToWorkspaces(envelope.payload, this.localSubscribedWorkspaces(client), workspaces)) continue
          const workspaceIds = hostFrameWorkspaceIds(envelope.payload, workspaces)
          const notifications: HubHostNotification[] = workspaceIds.length === 0
            ? [{ endpointId: this.config.endpointId, workspaceId: null, frame: envelope.payload }]
            : workspaceIds.map(workspaceId => ({ endpointId: this.config.endpointId, workspaceId, frame: envelope.payload }))
          for (const notification of notifications) {
            if (notification.workspaceId !== null
              && !this.localSubscribedWorkspaces(client).has(notification.workspaceId)) continue
            try { client.transport.notify('hub/host', notification) } catch { return }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          try {
            client.transport.notify('hub/host', {
              endpointId: this.config.endpointId,
              workspaceId: null,
              frame: { type: 'stream/error', error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } },
            })
          } catch { /* disconnected client */ }
        }
      }
    })()
  }

  /** Update the workspace filter applied before forwarding the host stream. */
  private handleWorkspaceSubscription(client: ClientRecord, params: { workspaces?: HubWorkspaceRef[] }): Record<string, never> {
    client.subscribedWorkspaces = new Map()
    for (const workspace of params.workspaces ?? []) {
      const ids = client.subscribedWorkspaces.get(workspace.endpointId) ?? new Set<string>()
      ids.add(workspace.workspaceId)
      client.subscribedWorkspaces.set(workspace.endpointId, ids)
    }
    return {}
  }

  private handleAgentHostEvent(client: ClientRecord, params: HubAgentHostEventParams): void {
    if (client.role !== 'agent' || client.endpointId !== params.endpointId) throw new Error('Endpoint Agent registration required')
    if (params.workspaceId !== null && !client.workspaces?.some(workspace => workspace.id === params.workspaceId)) {
      throw new Error(`remote workspace unavailable: ${params.endpointId}/${params.workspaceId}`)
    }
    this.broadcastHostNotification({ endpointId: params.endpointId, workspaceId: params.workspaceId, frame: params.frame })
  }

  private localSubscribedWorkspaces(client: ClientRecord): ReadonlySet<string> {
    return client.subscribedWorkspaces.get(this.config.endpointId) ?? new Set()
  }

  private broadcastHostNotification(notification: HubHostNotification): void {
    for (const client of this.clients.values()) {
      const selected = client.subscribedWorkspaces.get(notification.endpointId)
      if (selected === undefined || (notification.workspaceId !== null && !selected.has(notification.workspaceId))) continue
      try { client.transport.notify('hub/host', notification) } catch { /* disconnected client */ }
    }
  }

  /** Read the current workspace membership used by the host stream filter. */
  private workspaceEntries(): WorkspaceSubscriptionEntry[] {
    const registry = this.ctx.get('workspaceRegistry') as { list: () => Array<{ id: string; sessionIds: SessionId[] }> } | undefined
    return registry?.list() ?? []
  }

  private async handleList(): Promise<{ sessions: { header: import('@deepseek-ai/dsh-session').SessionHeader }[] }> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      // Fall back to the in-memory session store.
      const sessions = this.ctx.sessions.list()
      return {
        sessions: sessions.map(s => ({ header: s.header })),
      }
    }
    const headers = await persistence.list()
    return {
      sessions: headers.map((h: import('@deepseek-ai/dsh-session').SessionHeader) => ({ header: h })),
    }
  }

  /** List directories registered by the remote device's workspace service. */
  private async handleWorkspaces(params: { workspaces?: HubWorkspaceRef[] } = {}): Promise<import('@deepseek-ai/dsh-hub-protocol').HubWorkspaceListResult> {
    const registry = this.ctx.get('workspaceRegistry') as {
      list: () => Array<{ id: string; title: string; path: string; sessionIds: SessionId[] }>
      archivedSessionIds: readonly SessionId[]
    } | undefined
    const api = this.ctx.get('apiProxy') as {
      sessions?: {
        list: (request: {
          rpcId: string
          payload: Record<string, never>
        }) => Promise<{
          result: { ok: true
            value: { items: Array<{
              sessionId: SessionId
              updatedAt: number
              running: boolean
              blank: boolean
              cwd?: string
              agentPreset?: string
              parentSessionId?: SessionId
              origin?: 'subagent'
              projections?: { values?: { title?: string | null } }
            }> } } | { ok: false; error: unknown }
        }>
        history: (request: { rpcId: string; payload: { sessionId: SessionId; maxMessages: number } }) => Promise<{
          result: { ok: true; value: { projections?: { values?: { title?: string | null } } } } | { ok: false; error: unknown }
        }>
      }
    } | undefined
    const summaries = api === undefined || api.sessions === undefined
      ? []
      : await api.sessions.list({ rpcId: `hub-workspaces-${Date.now()}`, payload: {} }).then((response) => {
        if (!response.result.ok) throw new Error(`remote session listing failed: ${JSON.stringify(response.result.error)}`)
        return response.result.value.items
      })
    const byId = new Map(await Promise.all(summaries.map(async (summary) => {
      if (typeof summary.projections?.values?.title === 'string' && summary.projections.values.title !== '') {
        return [String(summary.sessionId), summary] as const
      }
      const history = api === undefined || api.sessions === undefined
        ? undefined
        : await api.sessions.history({
          rpcId: `hub-workspace-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          payload: { sessionId: summary.sessionId, maxMessages: 1 },
        })
      if (history?.result.ok !== true) return [String(summary.sessionId), summary] as const
      const title = history.result.value.projections?.values?.title
      return [String(summary.sessionId), typeof title === 'string' && title !== ''
        ? { ...summary, projections: { ...summary.projections, values: { ...summary.projections?.values, title } } }
        : summary] as const
    })))
    const archived = registry === undefined ? new Set<SessionId>() : new Set(registry.archivedSessionIds)
    const selected = params.workspaces === undefined ? undefined : new Set(
      params.workspaces.map(workspace => `${workspace.endpointId}\u0000${workspace.workspaceId}`),
    )
    const localWorkspaces = registry === undefined
      ? []
      : registry.list().map(workspace => ({
        endpointId: this.config.endpointId,
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessions: workspace.sessionIds,
      }))
    const agentWorkspaces = [...this.clients.values()].flatMap(client =>
      client.role === 'agent' ? client.workspaces ?? [] : [])
    return {
      endpointId: this.config.endpointId,
      workspaces: [...localWorkspaces, ...agentWorkspaces]
        .filter(workspace => selected === undefined || selected.has(`${workspace.endpointId}\u0000${workspace.id}`))
        .map(workspace => ({
          ...workspace,
          sessions: workspace.sessions.flatMap((sessionOrId) => {
            const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.sessionId
            if (archived.has(sessionId)) return []
            const summary = typeof sessionOrId === 'string' ? byId.get(String(sessionId)) : sessionOrId
            if (summary === undefined) return []
            const title = 'projections' in summary
              ? summary.projections.values?.title
              : 'title' in summary ? summary.title : undefined
            return [{
              sessionId: summary.sessionId,
              endpointId: workspace.endpointId,
              updatedAt: summary.updatedAt,
              running: summary.running,
              blank: summary.blank,
              ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
              ...(typeof title === 'string' && title !== '' ? { title } : {}),
              ...(summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset }),
              ...(summary.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId }),
              ...(summary.origin === undefined ? {} : { origin: summary.origin }),
            }]
          }),
        })),
    }
  }

  /** Forward a typed Host API request without changing its result payload. */
  private async handleApiRequest(params: HubApiRequestParams): Promise<unknown> {
    if (params.endpointId !== this.config.endpointId) {
      const agent = [...this.clients.values()].find(client => client.role === 'agent' && client.endpointId === params.endpointId)
      if (agent === undefined) throw new Error(`remote endpoint unavailable: ${params.endpointId}`)
      if (!agent.workspaces?.some(workspace => workspace.id === params.workspaceId)) {
        throw new Error(`remote workspace unavailable: ${params.endpointId}/${params.workspaceId}`)
      }
      return await agent.transport.request('hub/api/request', params)
    }
    const registry = this.ctx.get('workspaceRegistry') as { list: () => Array<{ id: string }> } | undefined
    if (registry === undefined) throw new Error('local workspace registry is unavailable')
    if (!registry.list().some(workspace => workspace.id === params.workspaceId)) {
      throw new Error(`local workspace unavailable: ${params.workspaceId}`)
    }
    const allowed = new Set([
      'session.list', 'session.create', 'session.history', 'session.models', 'session.selectModel',
      'session.rename', 'session.fork', 'session.prompt', 'session.attachment', 'session.updateQueue',
      'session.cancel', 'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
      'workspace.rename', 'workspace.delete', 'workspace.insertBefore', 'workspace.insertSessionBefore',
      'workspace.archiveSession',
    ])
    if (!allowed.has(params.method)) throw new Error(`unsupported remote API method: ${params.method}`)
    const [domain, operation] = params.method.split('.')
    const apiDomain = domain === 'session' ? 'sessions' : domain === 'subagent' ? 'subagents' : domain === 'agentPreset' ? 'agentPresets' : domain
    const api = this.ctx.get('apiProxy') as Record<string, Record<string, (request: unknown) => Promise<unknown>>> | undefined
    const handler = apiDomain === undefined || operation === undefined ? undefined : api?.[apiDomain]?.[operation]
    if (handler === undefined) throw new Error(`remote API method is unavailable: ${params.method}`)
    return await handler({ rpcId: `hub-api-${randomUUID()}`, payload: params.payload })
  }

  private handleSubscribe(
    client: ClientRecord,
    params: { id?: SessionId; workspaceId?: string },
  ): Record<string, never> {
    if (params.id) {
      if (params.workspaceId === undefined || params.workspaceId === '') throw new Error('workspaceId is required for a session subscription')
      client.subscribedSessions.add(sessionSubscriptionKey(params.workspaceId, params.id))
    } else client.subscribedAll = true
    return {}
  }

  private handleUnsubscribe(
    client: ClientRecord,
    params: { id?: SessionId; workspaceId?: string },
  ): Record<string, never> {
    if (params.id) {
      if (params.workspaceId === undefined || params.workspaceId === '') throw new Error('workspaceId is required for a session subscription')
      client.subscribedSessions.delete(sessionSubscriptionKey(params.workspaceId, params.id))
    } else {
      client.subscribedAll = false
      client.subscribedSessions.clear()
    }
    return {}
  }

  /** Broadcast a notification to all clients subscribed to a specific session. */
  private broadcastToSubscribers(
    workspaceId: string,
    sessionId: SessionId,
    method: string,
    notification: HubEventNotification | HubStatusNotification,
  ): void {
    for (const client of this.clients.values()) {
      if (client.subscribedAll || client.subscribedSessions.has(sessionSubscriptionKey(workspaceId, sessionId))) {
        try {
          client.transport.notify(method, notification)
        } catch {
          // Client may have disconnected; ignore.
        }
      }
    }
  }

  private workspaceForSession(sessionId: SessionId): string | undefined {
    const registry = this.ctx.get('workspaceRegistry') as { list: () => Array<{ id: string; sessionIds: SessionId[] }> } | undefined
    return registry?.list().find(workspace => workspace.sessionIds.includes(sessionId))?.id
  }
}

function sessionSubscriptionKey(workspaceId: string, sessionId: SessionId): string {
  return `${workspaceId}\u0000${String(sessionId)}`
}

function parseApiRequestParams(params: Record<string, unknown>): HubApiRequestParams {
  if (typeof params.endpointId !== 'string' || !/^remote:[^\s]+$/u.test(params.endpointId)
    || typeof params.workspaceId !== 'string' || params.workspaceId === ''
    || typeof params.method !== 'string' || params.method === ''
    || !isRecord(params.payload)) {
    throw new Error('invalid Hub API request')
  }
  return {
    endpointId: params.endpointId as `remote:${string}`,
    workspaceId: params.workspaceId,
    method: params.method,
    payload: params.payload,
  }
}

function requireEndpointId(endpointId: `remote:${string}`): `remote:${string}` {
  if (!/^remote:[^\s]+$/u.test(endpointId)) throw new Error(`invalid Hub endpoint identity: ${endpointId}`)
  return endpointId
}

function parseAgentRegisterParams(params: Record<string, unknown>): HubAgentRegisterParams {
  if (typeof params.endpointId !== 'string' || !/^remote:[^\s]+$/u.test(params.endpointId)
    || typeof params.token !== 'string' || params.token === ''
    || !isServerInfo(params.serverInfo)
    || (params.version !== undefined && typeof params.version !== 'string')) {
    throw new Error('invalid Endpoint Agent registration')
  }
  return {
    endpointId: params.endpointId as `remote:${string}`,
    token: params.token,
    ...(params.version === undefined ? {} : { version: params.version }),
    serverInfo: params.serverInfo,
    workspaces: parseWorkspaces(params.workspaces),
  }
}

function parseWorkspacePublishParams(params: Record<string, unknown>): { workspaces: HubWorkspaceEntry[] } {
  return { workspaces: parseWorkspaces(params.workspaces) }
}

function parseWorkspaceSubscriptionParams(params: Record<string, unknown>): { workspaces?: HubWorkspaceRef[] } {
  if (params.workspaces === undefined) return {}
  if (!Array.isArray(params.workspaces)) throw new Error('invalid Hub workspace subscription')
  return {
    workspaces: params.workspaces.map((workspace) => {
      if (!isRecord(workspace)
        || typeof workspace.endpointId !== 'string'
        || !/^remote:[^\s]+$/u.test(workspace.endpointId)
        || typeof workspace.workspaceId !== 'string'
        || workspace.workspaceId === '') {
        throw new Error('invalid Hub workspace subscription')
      }
      return workspace as unknown as HubWorkspaceRef
    }),
  }
}

function parseAgentHostEventParams(params: Record<string, unknown>): HubAgentHostEventParams {
  if (typeof params.endpointId !== 'string' || !/^remote:[^\s]+$/u.test(params.endpointId)
    || typeof params.workspaceId !== 'string' || params.workspaceId === ''
    || !isRecord(params.frame) || typeof params.frame.type !== 'string') {
    throw new Error('invalid Endpoint Agent Host event')
  }
  return {
    endpointId: params.endpointId as `remote:${string}`,
    workspaceId: params.workspaceId,
    frame: params.frame as HubAgentHostEventParams['frame'],
  }
}

function parseWorkspaces(value: unknown): HubWorkspaceEntry[] {
  if (!Array.isArray(value)) throw new Error('invalid Endpoint Agent workspace directory')
  return value.map((workspace) => {
    if (!isRecord(workspace)
      || typeof workspace.endpointId !== 'string'
      || !/^remote:[^\s]+$/u.test(workspace.endpointId)
      || typeof workspace.id !== 'string'
      || typeof workspace.title !== 'string'
      || typeof workspace.path !== 'string'
      || !Array.isArray(workspace.sessions)) {
      throw new Error('invalid Endpoint Agent workspace directory')
    }
    const sessions = workspace.sessions.map((session) => {
      if (!isRecord(session)
        || typeof session.endpointId !== 'string'
        || !/^remote:[^\s]+$/u.test(session.endpointId)
        || typeof session.sessionId !== 'string'
        || typeof session.updatedAt !== 'number'
        || !Number.isFinite(session.updatedAt)
        || typeof session.running !== 'boolean'
        || typeof session.blank !== 'boolean') {
        throw new Error('invalid Endpoint Agent workspace directory')
      }
      return session as unknown as HubWorkspaceEntry['sessions'][number]
    })
    return { ...workspace, sessions } as HubWorkspaceEntry
  })
}

function isServerInfo(value: unknown): value is { name: string; version: string } {
  return isRecord(value) && typeof value.name === 'string' && value.name !== ''
    && typeof value.version === 'string' && value.version !== ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

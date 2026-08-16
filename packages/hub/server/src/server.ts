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
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  JsonRpcWebSocketTransport,
  type HubHandshakeParams,
  type HubHandshakeResult,
  type HubCapabilities,
  type HubEventNotification,
  type HubStatusNotification,
} from '@deepseek-ai/dsh-hub-protocol'

/** A connected client session record. */
interface ClientRecord {
  id: string
  transport: JsonRpcWebSocketTransport
  subscribedSessions: Set<SessionId>
  subscribedAll: boolean
  authenticated: boolean
}

/**
 * Hub server configuration.
 */
export interface HubServerConfig {
  /** Stable identity exposed to clients for this Hub endpoint. */
  endpointId?: `remote:${string}`
  /** TCP port to listen on. Defaults to 8765. */
  port?: number
  /** Host to bind to. Defaults to '0.0.0.0'. */
  host?: string
  /** Optional set of authentication tokens. */
  authTokens?: string[]
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

  constructor(
    private readonly ctx: Context,
    config: HubServerConfig = {},
  ) {
    this.config = {
      endpointId: config.endpointId ?? `remote:${config.serverName ?? DEFAULTS.serverName}`,
      port: config.port ?? DEFAULTS.port,
      host: config.host ?? DEFAULTS.host,
      authTokens: config.authTokens ?? [],
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
    this.httpServer.listen(this.config.port, this.config.host)
    this.ctx.logger.info(`hub server listening on ${this.config.host}:${this.config.port}`)

    // Subscribe to session events for forwarding to subscribed clients.
    this.eventDisposers.push(this.ctx.on('session/event', (_session, event) => {
      const sessionId = _session.id
      const notification: HubEventNotification = { endpointId: this.config.endpointId, sessionId, event }
      this.broadcastToSubscribers(sessionId, 'hub/event', notification)
    }))

    // Subscribe to session lifecycle events.
    this.eventDisposers.push(this.ctx.on('session/created', (session) => {
      const notification: HubStatusNotification = {
        endpointId: this.config.endpointId,
        sessionId: session.id,
        status: 'created',
      }
      this.broadcastToSubscribers(session.id, 'hub/status', notification)
    }))

    this.eventDisposers.push(this.ctx.on('session/disposed', (session) => {
      const notification: HubStatusNotification = {
        endpointId: this.config.endpointId,
        sessionId: session.id,
        status: 'disposed',
      }
      this.broadcastToSubscribers(session.id, 'hub/status', notification)
    }))
  }

  /** Stop the server and close all connections. */
  async stop(): Promise<void> {
    for (const dispose of this.eventDisposers.splice(0)) dispose()
    for (const [id, client] of this.clients) {
      client.transport.close()
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
      transport,
      subscribedSessions: new Set(),
      subscribedAll: false,
      authenticated: this.config.authTokens.length === 0,
    }
    this.clients.set(clientId, client)

    transport.onRequest(async (method, params) => {
      return this.handleRequest(client, method, params)
    })

    transport.start()

    ws.on('close', () => {
      transport.close()
      this.clients.delete(clientId)
    })
  }

  private async handleRequest(
    client: ClientRecord,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== 'hub/handshake' && !client.authenticated) {
      throw new Error('handshake required')
    }
    switch (method) {
      case 'hub/handshake':
        return this.handleHandshake(client, params)
      case 'hub/list':
        return this.handleList()
      case 'hub/workspaces':
        return await this.handleWorkspaces()
      case 'hub/workspace-session/create':
        return await this.handleWorkspaceSessionCreate(params as { workspaceId: string })
      case 'hub/session/models':
        return await this.handleSessionModels(params as { id: SessionId })
      case 'hub/session/select-model':
        return await this.handleSessionSelectModel(params as { id: SessionId; provider: string; model: string; reasoningEffort?: string })
      case 'hub/session/rename':
        return await this.handleSessionRename(params as { id: SessionId; title: string })
      case 'hub/session/update-queue':
        return await this.handleSessionUpdateQueue(params as { id: SessionId; itemId: string; action: never })
      case 'hub/session/attachment':
        return await this.handleSessionAttachment(params as { id: SessionId; attachmentId: string })
      case 'hub/session/fork':
        return await this.handleSessionFork(params as { id: SessionId; atSeq?: number })
      case 'hub/session/history':
        return await this.handleSessionHistory(params as { id: SessionId; beforeSeq?: number; maxMessages?: number })
      case 'hub/session/prompt':
        return await this.handleSessionPrompt(params as { id: SessionId; content: unknown[]; mode: 'queue' | 'steer'; clientTimeZone?: string })
      case 'hub/subagent/list':
        return await this.handleSubagent('list', params)
      case 'hub/subagent/history':
        return await this.handleSubagent('history', params)
      case 'hub/subagent/prompt':
        return await this.handleSubagent('prompt', params)
      case 'hub/subagent/interrupt':
        return await this.handleSubagent('interrupt', params)
      case 'hub/create':
        return this.handleCreate(params as { meta: import('@deepseek-ai/dsh-session').SessionHeader })
      case 'hub/load':
        return this.handleLoad(params as { id: SessionId })
      case 'hub/append':
        return this.handleAppend(params as { id: SessionId; events: import('@deepseek-ai/dsh-session').SessionEvent[] })
      case 'hub/inspect':
        return this.handleInspect(params as { id: SessionId })
      case 'hub/delete':
        return this.handleDelete(params as { id: SessionId })
      case 'hub/agent/message':
        return this.handleAgentMessage(params as { id: SessionId; message: UserMessage; mode?: 'queue' | 'steer' })
      case 'hub/agent/cancel':
        return this.handleAgentCancel(params as { id: SessionId; cause?: 'user' | 'shutdown' | 'remote' })
      case 'hub/subscribe':
        return this.handleSubscribe(client, params)
      case 'hub/unsubscribe':
        return this.handleUnsubscribe(client, params)
      default:
        throw new Error(`unknown hub method: ${method}`)
    }
  }

  private async handleSubagent(method: 'list' | 'history' | 'prompt' | 'interrupt', params: Record<string, unknown>): Promise<unknown> {
    const api = this.ctx.get('apiProxy') as {
      subagents?: Record<string, (request: unknown, signal?: AbortSignal) => Promise<{ result: unknown }>>
    } | undefined
    const operation = api?.subagents?.[method]
    if (operation === undefined) throw new Error('remote subagent API is unavailable')
    const response = await operation({ rpcId: `hub-subagent-${method}-${Date.now()}`, payload: params })
    const result = response.result as { ok?: boolean; value?: unknown; error?: unknown }
    if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : `remote subagent ${method} failed`)
    return result.value
  }

  private handleHandshake(client: ClientRecord, params: HubHandshakeParams): HubHandshakeResult {
    // Validate auth token.
    if (this.config.authTokens.length > 0) {
      if (!params.token || !this.config.authTokens.includes(params.token)) {
        throw new Error('authentication failed')
      }
    }
    client.authenticated = true

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
  private async handleWorkspaces(): Promise<import('@deepseek-ai/dsh-hub-protocol').HubWorkspaceListResult> {
    const registry = this.ctx.get('workspaceRegistry') as {
      list: () => Array<{ id: string; title: string; path: string; sessionIds: SessionId[] }>
    } | undefined
    const api = this.ctx.get('apiProxy') as {
      sessions: {
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
    const summaries = api === undefined
      ? []
      : await api.sessions.list({ rpcId: `hub-workspaces-${Date.now()}`, payload: {} }).then((response) => {
        if (!response.result.ok) throw new Error(`remote session listing failed: ${JSON.stringify(response.result.error)}`)
        return response.result.value.items
      })
    const byId = new Map(await Promise.all(summaries.map(async (summary) => {
      if (typeof summary.projections?.values?.title === 'string' && summary.projections.values.title !== '') {
        return [String(summary.sessionId), summary] as const
      }
      const history = api === undefined
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
    return {
      endpointId: this.config.endpointId,
      workspaces: registry?.list().map(workspace => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessions: workspace.sessionIds.flatMap((sessionId) => {
          const summary = byId.get(String(sessionId))
          if (summary === undefined) return []
          const title = summary.projections?.values?.title
          return [{
            sessionId: summary.sessionId,
            endpointId: this.config.endpointId,
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
      })) ?? [],
    }
  }

  private async handleWorkspaceSessionCreate(params: { workspaceId: string }): Promise<{ sessionId: SessionId }> {
    const api = this.ctx.get('apiProxy') as {
      sessions: {
        create: (request: { rpcId: string; payload: { workspaceId: string } }) => Promise<{
          result: { ok: true; value: { sessionId: SessionId } } | { ok: false; error: unknown }
        }>
      }
    } | undefined
    if (api === undefined) throw new Error('remote api proxy is unavailable')
    const agentPreset = this.config.workspacePresets[params.workspaceId]
    const response = await api.sessions.create({
      rpcId: `hub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        workspaceId: params.workspaceId,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
    })
    if (!response.result.ok) throw new Error(`remote session creation failed: ${JSON.stringify(response.result.error)}`)
    return response.result.value
  }

  private async handleSessionModels(
    params: { id: SessionId },
  ): Promise<Record<string, unknown>> {
    const api = this.ctx.get('apiProxy') as {
      sessions: {
        models: (request: { rpcId: string; payload: { sessionId: SessionId } }) => Promise<{
          result: { ok: true; value: Record<string, unknown> } | { ok: false; error: unknown }
        }>
      }
    } | undefined
    if (api === undefined) throw new Error('remote api proxy is unavailable')
    const response = await api.sessions.models({
      rpcId: `hub-models-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: { sessionId: params.id },
    })
    if (!response.result.ok) {
      throw new Error(`remote model listing failed: ${JSON.stringify(response.result.error)}`)
    }
    return response.result.value
  }

  private async handleSessionSelectModel(
    params: { id: SessionId; provider: string; model: string; reasoningEffort?: string },
  ): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }> {
    const api = this.ctx.get('apiProxy') as {
      sessions: {
        selectModel: (request: {
          rpcId: string
          payload: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }
        }) => Promise<{
          result: { ok: true; value: { selected: { provider: string; model: string; reasoningEffort?: string } } }
            | { ok: false; error: unknown }
        }>
      }
    } | undefined
    if (api === undefined) throw new Error('remote api proxy is unavailable')
    const response = await api.sessions.selectModel({
      rpcId: `hub-select-model-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        sessionId: params.id,
        provider: params.provider,
        model: params.model,
        ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
      },
    })
    if (!response.result.ok) throw new Error(`remote model selection failed: ${JSON.stringify(response.result.error)}`)
    return response.result.value
  }

  private async handleSessionRename(params: { id: SessionId; title: string }): Promise<{ title: string; seq: number }> {
    const api = this.ctx.get('apiProxy') as { sessions: { rename: (request: { rpcId: string; payload: { sessionId: SessionId; title: string } }) => Promise<{ result: { ok: true; value: { title: string; seq: number } } | { ok: false; error: unknown } }> } }
    const response = await api.sessions.rename({ rpcId: `hub-rename-${randomUUID()}`, payload: { sessionId: params.id, title: params.title } })
    if (!response.result.ok) throw new Error(`remote session rename failed: ${JSON.stringify(response.result.error)}`)
    return response.result.value
  }

  private async handleSessionUpdateQueue(params: { id: SessionId; itemId: string; action: never }): Promise<{ accepted: true }> {
    const api = this.ctx.get('apiProxy') as { sessions: { updateQueue: (request: { rpcId: string; payload: { sessionId: SessionId; itemId: string; action: never } }) => Promise<{ result: { ok: true; value: { accepted: true } } | { ok: false; error: unknown } }> } }
    const response = await api.sessions.updateQueue({ rpcId: `hub-queue-${randomUUID()}`, payload: { sessionId: params.id, itemId: params.itemId, action: params.action } })
    if (!response.result.ok) throw new Error(`remote queue update failed: ${JSON.stringify(response.result.error)}`)
    return response.result.value
  }

  private async handleSessionAttachment(
    params: { id: SessionId; attachmentId: string },
  ): Promise<{ attachment: unknown; data: string }> {
    const api = this.ctx.get('apiProxy') as {
      sessions: {
        attachment: (request: {
          rpcId: string
          payload: { sessionId: SessionId; attachmentId: string }
        }) => Promise<{
          result: { ok: true; value: { attachment: unknown; data: string } }
            | { ok: false; error: unknown }
        }>
      }
    }
    const response = await api.sessions.attachment({ rpcId: `hub-attachment-${randomUUID()}`, payload: { sessionId: params.id, attachmentId: params.attachmentId } })
    if (!response.result.ok) throw new Error(`remote attachment read failed: ${JSON.stringify(response.result.error)}`)
    return response.result.value
  }

  private async handleSessionFork(
    params: { id: SessionId; atSeq?: number },
  ): Promise<{ sessionId: SessionId }> {
    const api = this.ctx.get('apiProxy') as {
      sessions: {
        fork: (request: {
          rpcId: string
          payload: { sessionId: SessionId; atSeq?: number }
        }) => Promise<{
          result: { ok: true; value: { sessionId: SessionId } }
            | { ok: false; error: unknown }
        }>
      }
    }
    const response = await api.sessions.fork({ rpcId: `hub-fork-${randomUUID()}`, payload: { sessionId: params.id, ...(params.atSeq === undefined ? {} : { atSeq: params.atSeq }) } })
    if (!response.result.ok) throw new Error(`remote session fork failed: ${JSON.stringify(response.result.error)}`)
    return response.result.value
  }

  private async handleSessionHistory(params: { id: SessionId; beforeSeq?: number; maxMessages?: number }): Promise<unknown> {
    const api = this.ctx.get('apiProxy') as {
      sessions?: {
        history: (request: {
          rpcId: string
          payload: { sessionId: SessionId; beforeSeq?: number; maxMessages?: number }
        }) => Promise<{ result: unknown }>
      }
    } | undefined
    const history = api?.sessions?.history
    if (history === undefined) throw new Error('remote session history API is unavailable')
    const response = await history({
      rpcId: `hub-session-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      payload: {
        sessionId: params.id,
        ...(params.beforeSeq === undefined ? {} : { beforeSeq: params.beforeSeq }),
        ...(params.maxMessages === undefined ? {} : { maxMessages: params.maxMessages }),
      },
    })
    const result = response.result as { ok?: boolean; value?: unknown; error?: unknown }
    if (result.ok !== true) throw new Error(typeof result.error === 'string' ? result.error : `remote session history failed: ${JSON.stringify(result.error)}`)
    return result.value
  }

  private async handleSessionPrompt(params: { id: SessionId; content: unknown[]; mode: 'queue' | 'steer'; clientTimeZone?: string }): Promise<{ accepted: true }> {
    const api = this.ctx.get('apiProxy') as {
      sessions?: {
        prompt: (request: { rpcId: string; payload: { sessionId: SessionId; content: unknown[]; mode: 'queue' | 'steer'; clientTimeZone?: string } }) => Promise<{ result: { ok: true; value: unknown } | { ok: false; error: unknown } }>
      }
    } | undefined
    const prompt = api?.sessions?.prompt
    if (prompt === undefined) throw new Error('remote session prompt API is unavailable')
    const response = await prompt({
      rpcId: `hub-session-prompt-${randomUUID()}`,
      payload: {
        sessionId: params.id,
        content: params.content,
        mode: params.mode,
        ...(params.clientTimeZone === undefined ? {} : { clientTimeZone: params.clientTimeZone }),
      },
    })
    if (!response.result.ok) throw new Error(`remote session prompt failed: ${JSON.stringify(response.result.error)}`)
    return { accepted: true }
  }

  private async handleCreate(
    params: { meta: import('@deepseek-ai/dsh-session').SessionHeader },
  ): Promise<{ id: SessionId }> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      await persistence.create(params.meta)
    }
    return { id: params.meta.id }
  }

  private async handleLoad(
    params: { id: SessionId },
  ): Promise<{ meta: import('@deepseek-ai/dsh-session').SessionHeader; events: import('@deepseek-ai/dsh-session').SessionEvent[] }> {
    // A live session is authoritative while its write-behind persistence has
    // not flushed the first event yet. This also keeps a newly created remote
    // workspace session readable immediately after creation.
    const live = this.ctx.sessions.get(params.id)
    if (live !== undefined) {
      return { meta: live.header, events: [...live.events] }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      const session = this.ctx.sessions.get(params.id)
      if (session === undefined) throw new Error(`session not found: ${params.id}`)
      return { meta: session.header, events: [...session.events] }
    }
    try {
      const result = await persistence.load(params.id)
      return { meta: result.meta, events: [...result.events] }
    } catch (error) {
      throw error
    }
  }

  private async handleAppend(
    params: { id: SessionId; events: import('@deepseek-ai/dsh-session').SessionEvent[] },
  ): Promise<Record<string, never>> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence !== undefined) {
      await persistence.append(params.id, params.events)
    }
    return {}
  }

  private async handleInspect(
    params: { id: SessionId },
  ): Promise<{ meta: import('@deepseek-ai/dsh-session').SessionHeader; events: import('@deepseek-ai/dsh-session').SessionEvent[] }> {
    const live = this.ctx.sessions.get(params.id)
    if (live !== undefined) {
      return { meta: live.header, events: [...live.events] }
    }
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      const session = this.ctx.sessions.get(params.id)
      if (session === undefined) throw new Error(`session not found: ${params.id}`)
      return { meta: session.header, events: [...session.events] }
    }
    try {
      const result = await persistence.inspect(params.id)
      return { meta: result.meta, events: [...result.events] }
    } catch (error) {
      throw error
    }
  }

  private handleDelete(params: { id: SessionId }): Record<string, never> {
    throw new Error(`session deletion is not supported: ${params.id}`)
  }

  private async handleAgentMessage(
    params: { id: SessionId; message: UserMessage; mode?: 'queue' | 'steer' },
  ): Promise<{ accepted: true }> {
    const api = this.ctx.get('apiProxy') as {
      sessions: {
        prompt: (request: { rpcId: string; payload: { sessionId: SessionId; mode: 'queue' | 'steer'; content: UserMessage['content'] } }) => Promise<{
          result: { ok: true; value: { accepted: true } } | { ok: false; error: unknown }
        }>
      }
    } | undefined
    if (api === undefined) throw new Error('remote api proxy is unavailable')
    const response = await api.sessions.prompt({
      rpcId: `hub-agent-message-${randomUUID()}`,
      payload: {
        sessionId: params.id,
        mode: params.mode ?? 'queue',
        content: params.message.content,
      },
    })
    if (!response.result.ok) throw new Error(`remote prompt failed: ${JSON.stringify(response.result.error)}`)
    return response.result.value
  }

  private async handleAgentCancel(
    params: { id: SessionId; cause?: 'user' | 'shutdown' | 'remote' },
  ): Promise<Record<string, never>> {
    const api = this.ctx.get('apiProxy') as {
      sessions: {
        cancel: (request: { rpcId: string; payload: { sessionId: SessionId } }) => Promise<{
          result: { ok: true; value: Record<string, never> } | { ok: false; error: unknown }
        }>
      }
    } | undefined
    if (api === undefined) throw new Error('remote api proxy is unavailable')
    const response = await api.sessions.cancel({
      rpcId: `hub-agent-cancel-${randomUUID()}`,
      payload: { sessionId: params.id },
    })
    if (!response.result.ok) throw new Error(`remote cancel failed: ${JSON.stringify(response.result.error)}`)
    return response.result.value
  }

  private handleSubscribe(
    client: ClientRecord,
    params: { id?: SessionId },
  ): Record<string, never> {
    if (params.id) {
      client.subscribedSessions.add(params.id)
    } else client.subscribedAll = true
    return {}
  }

  private handleUnsubscribe(
    client: ClientRecord,
    params: { id?: SessionId },
  ): Record<string, never> {
    if (params.id) {
      client.subscribedSessions.delete(params.id)
    } else {
      client.subscribedAll = false
      client.subscribedSessions.clear()
    }
    return {}
  }

  /** Broadcast a notification to all clients subscribed to a specific session. */
  private broadcastToSubscribers(
    sessionId: SessionId,
    method: string,
    notification: HubEventNotification | HubStatusNotification,
  ): void {
    for (const client of this.clients.values()) {
      if (client.subscribedAll || client.subscribedSessions.has(sessionId)) {
        try {
          client.transport.notify(method, notification)
        } catch {
          // Client may have disconnected; ignore.
        }
      }
    }
  }
}

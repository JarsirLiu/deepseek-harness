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
}

/**
 * Hub server configuration.
 */
export interface HubServerConfig {
  /** TCP port to listen on. Defaults to 8765. */
  port?: number
  /** Host to bind to. Defaults to '0.0.0.0'. */
  host?: string
  /** Optional set of authentication tokens. */
  authTokens?: string[]
  /** Server identity name. */
  serverName?: string
}

const DEFAULTS = {
  port: 8765,
  host: '0.0.0.0',
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
  private readonly config: Required<HubServerConfig>
  private started = false

  constructor(
    private readonly ctx: Context,
    config: HubServerConfig = {},
  ) {
    this.config = {
      port: config.port ?? DEFAULTS.port,
      host: config.host ?? DEFAULTS.host,
      authTokens: config.authTokens ?? [],
      serverName: config.serverName ?? DEFAULTS.serverName,
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
    this.ctx.on('session/event', (_session, event) => {
      const sessionId = _session.id
      const notification: HubEventNotification = { sessionId, event }
      this.broadcastToSubscribers(sessionId, 'hub/event', notification)
    })

    // Subscribe to session lifecycle events.
    this.ctx.on('session/created', (session) => {
      const notification: HubStatusNotification = {
        sessionId: session.id,
        status: 'created',
      }
      this.broadcastToSubscribers(session.id, 'hub/status', notification)
    })

    this.ctx.on('session/disposed', (session) => {
      const notification: HubStatusNotification = {
        sessionId: session.id,
        status: 'disposed',
      }
      this.broadcastToSubscribers(session.id, 'hub/status', notification)
    })
  }

  /** Stop the server and close all connections. */
  async stop(): Promise<void> {
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
    switch (method) {
      case 'hub/handshake':
        return this.handleHandshake(params)
      case 'hub/list':
        return this.handleList()
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
      case 'hub/subscribe':
        return this.handleSubscribe(client, params)
      case 'hub/unsubscribe':
        return this.handleUnsubscribe(client, params)
      default:
        throw new Error(`unknown hub method: ${method}`)
    }
  }

  private handleHandshake(params: HubHandshakeParams): HubHandshakeResult {
    // Validate auth token.
    if (this.config.authTokens.length > 0) {
      if (!params.token || !this.config.authTokens.includes(params.token)) {
        throw new Error('authentication failed')
      }
    }

    const capabilities: HubCapabilities = {
      subscriptions: true,
      delete: true,
    }

    return {
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
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      const session = this.ctx.sessions.get(params.id)
      if (session === undefined) throw new Error(`session not found: ${params.id}`)
      return { meta: session.header, events: [...session.events] }
    }
    const result = await persistence.load(params.id)
    return { meta: result.meta, events: [...result.events] }
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
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      const session = this.ctx.sessions.get(params.id)
      if (session === undefined) throw new Error(`session not found: ${params.id}`)
      return { meta: session.header, events: [...session.events] }
    }
    const result = await persistence.inspect(params.id)
    return { meta: result.meta, events: [...result.events] }
  }

  private handleDelete(params: { id: SessionId }): Record<string, never> {
    // Session deletion is not directly supported by the current SessionPersistence API.
    // For now, this is a no-op that returns success.
    this.ctx.logger.info(`hub: delete requested for session ${params.id} (not yet implemented)`)
    return {}
  }

  private handleSubscribe(
    client: ClientRecord,
    params: { id?: SessionId },
  ): Record<string, never> {
    if (params.id) {
      client.subscribedSessions.add(params.id)
    }
    return {}
  }

  private handleUnsubscribe(
    client: ClientRecord,
    params: { id?: SessionId },
  ): Record<string, never> {
    if (params.id) {
      client.subscribedSessions.delete(params.id)
    } else {
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
      if (client.subscribedSessions.size === 0 || client.subscribedSessions.has(sessionId)) {
        try {
          client.transport.notify(method, notification)
        } catch {
          // Client may have disconnected; ignore.
        }
      }
    }
  }
}

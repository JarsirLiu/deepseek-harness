/**
 * Remote session provider: forwards remote session operations over WebSocket
 * JSON-RPC without registering a local session persistence service.
 *
 * @module @deepseek-ai/dsh-hub-client/remote-session-provider
 */

import WebSocket from 'ws'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionInspection, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import {
  JsonRpcWebSocketTransport,
  type JsonRpcTransportPeer,
  type HubHandshakeResult,
  type HubEventNotification,
  type HubStatusNotification,
} from '@deepseek-ai/dsh-hub-protocol'

/** Connection state for the remote hub. */
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Error thrown when the hub connection fails. */
export class HubConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubConnectionError'
  }
}

/** Remote Agent command surface used by a local Web/API adapter. */
export class RemoteAgentClient {
  constructor(private readonly provider: RemoteSessionProvider) {}

  /** Queue one text prompt on the remote Agent. */
  async sendText(sessionId: SessionId, text: string): Promise<void> {
    await this.send(sessionId, createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
  }

  /** Queue one already normalized user message on the remote Agent. */
  async send(sessionId: SessionId, message: UserMessage): Promise<void> {
    await this.sendMessage(sessionId, message, 'queue')
  }

  /** Queue or steer one user message on the remote Agent. */
  async sendMessage(sessionId: SessionId, message: UserMessage, mode: 'queue' | 'steer'): Promise<void> {
    await this.provider.request('hub/agent/message', { id: sessionId, message, mode })
  }

  /** Cancel the remote Agent's active turn. */
  async cancel(sessionId: SessionId): Promise<void> {
    await this.provider.request('hub/agent/cancel', { id: sessionId, cause: 'user' })
  }

  /** Forward remote session events to a host API event carrier. */
  onEvent(listener: (notification: HubEventNotification) => void): () => void {
    return this.provider.onEvent(listener)
  }
}

/** Configuration for a remote hub connection. */
export interface RemoteHubConfig {
  /** WebSocket URI of the remote hub server, e.g. ws://192.168.1.100:8765/hub */
  uri: string
  /** Optional authentication token. */
  token?: string
  /** Reconnect delay in milliseconds. */
  reconnectDelay?: number
}

const DEFAULTS = {
  reconnectDelay: 3000,
}

/**
 * A remote session transport that delegates session operations to a remote
 * harness hub server over WebSocket JSON-RPC. Local persistence remains the
 * process-wide `sessionPersistence` service.
 */
export class RemoteSessionProvider {
  private ws: WebSocket | null = null
  private transport: JsonRpcTransportPeer | null = null
  private state: ConnectionState = 'disconnected'
  private handshakeResult: HubHandshakeResult | null = null
  private readonly config: Required<RemoteHubConfig>
  private readonly eventListeners = new Map<
    string,
    Set<(notification: HubEventNotification) => void>
  >()
  private readonly statusListeners = new Set<
    (notification: HubStatusNotification) => void
  >()

  /** Request access for the provider-owned command client. */
  request(method: string, params: object): Promise<unknown> {
    return this.ensureConnected().request(method, params)
  }

  constructor(ctx: Context, config: RemoteHubConfig) {
    void ctx
    this.config = {
      uri: config.uri,
      token: config.token ?? '',
      reconnectDelay: config.reconnectDelay ?? DEFAULTS.reconnectDelay,
    }
  }

  /** Connect to the remote hub. Must be called before any session operations. */
  async connect(): Promise<void> {
    if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) return
    if (this.state === 'connecting') throw new Error('already connecting')

    this.state = 'connecting'
    try {
      const ws = new WebSocket(this.config.uri)
      this.ws = ws
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new HubConnectionError('WebSocket connection timeout'))
        }, 10000)

        ws.on('open', () => {
          clearTimeout(timeout)
          resolve()
        })
        ws.on('error', (error) => {
          clearTimeout(timeout)
          reject(new HubConnectionError(`WebSocket error: ${error.message}`))
        })
      })

      // Set up the transport.
      const transport = new JsonRpcWebSocketTransport(ws)
      this.transport = transport
      transport.start()

      // Perform handshake.
      this.handshakeResult = await transport.request('hub/handshake', {
        token: this.config.token || undefined,
        version: '0.1.0',
      }) as HubHandshakeResult

      this.state = 'connected'
      await transport.request('hub/subscribe', {})

      // Set up notification handlers.
      ws.on('message', (data) => {
        try {
          const text = Buffer.isBuffer(data)
            ? data.toString()
            : Array.isArray(data)
              ? Buffer.concat(data).toString()
              : Buffer.from(data).toString()
          const message: unknown = JSON.parse(text)
          if (!isRecord(message)) return
          if (message.method === 'hub/event' && isRecord(message.params)) {
            const notification = message.params as unknown as HubEventNotification
            const listeners = this.eventListeners.get(String(notification.sessionId))
            if (listeners) {
              for (const listener of listeners) {
                try { listener(notification) } catch { /* ignore */ }
              }
            }
            // Also notify wildcard listeners.
            const wildcard = this.eventListeners.get('*')
            if (wildcard) {
              for (const listener of wildcard) {
                try { listener(notification) } catch { /* ignore */ }
              }
            }
          } else if (message.method === 'hub/status' && isRecord(message.params)) {
            const notification = message.params as unknown as HubStatusNotification
            for (const listener of this.statusListeners) {
              try { listener(notification) } catch { /* ignore */ }
            }
          }
        } catch {
          // Ignore parse errors.
        }
      })

      ws.on('close', () => {
        this.state = 'disconnected'
        this.transport = null
      })

      ws.on('error', () => {
        this.state = 'error'
      })
    } catch (error) {
      this.state = 'error'
      this.ws?.close()
      this.ws = null
      this.transport = null
      throw error
    }
  }

  /** Disconnect from the remote hub. */
  disconnect(): void {
    this.state = 'disconnected'
    this.ws?.close()
    this.ws = null
    this.transport = null
    this.handshakeResult = null
  }

  /** Whether the provider is currently connected. */
  get isConnected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN
  }

  /** Current connection state. */
  get connectionState(): ConnectionState {
    return this.state
  }

  /** Handshake result with server info, or null if not yet connected. */
  get connectedServerInfo(): HubHandshakeResult | null {
    return this.handshakeResult
  }

  /**
   * Subscribe to events from a specific session.
   * @param sessionId - session whose events should be delivered.
   * @param listener - callback invoked for each matching event notification.
   * @returns disposer that removes the listener.
   */
  subscribe(sessionId: SessionId, listener: (notification: HubEventNotification) => void): () => void {
    if (!this.eventListeners.has(String(sessionId))) {
      this.eventListeners.set(String(sessionId), new Set())
    }
    const listeners = this.eventListeners.get(String(sessionId))
    if (listeners === undefined) throw new Error('event listener set was not registered')
    const wasEmpty = listeners.size === 0
    listeners.add(listener)
    if (wasEmpty) {
      void this.request('hub/subscribe', { id: sessionId })
    }
    return () => {
      const current = this.eventListeners.get(String(sessionId))
      if (current?.delete(listener) && current.size === 0) {
        void this.request('hub/unsubscribe', { id: sessionId })
      }
    }
  }

  /** Subscribe to every remote session event for a host API event bridge. */
  onEvent(listener: (notification: HubEventNotification) => void): () => void {
    const listeners = this.eventListeners.get('*') ?? new Set()
    this.eventListeners.set('*', listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.eventListeners.delete('*')
    }
  }

  /** Ensure the transport is available. */
  private ensureConnected(): JsonRpcTransportPeer {
    if (!this.transport || !this.isConnected) {
      throw new HubConnectionError('not connected to remote hub')
    }
    return this.transport
  }

  // ── SessionPersistence implementation ─────────────────────────────

  locate(_meta: SessionHeader): { kind: string; path: string } | undefined {
    // Remote sessions have no local artifact path.
    return undefined
  }

  readonly supportsRawArtifacts = false

  async create(meta: SessionHeader): Promise<void> {
    const transport = this.ensureConnected()
    await transport.request('hub/create', { meta })
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const transport = this.ensureConnected()
    await transport.request('hub/append', { id, events: [...events] })
  }

  async load(id: SessionId): Promise<SessionInspection> {
    const transport = this.ensureConnected()
    const result = await transport.request('hub/load', { id }) as {
      meta: SessionHeader
      events: SessionEvent[]
    }
    return { meta: result.meta, events: result.events }
  }

  async inspect(id: SessionId, _signal?: AbortSignal): Promise<SessionInspection> {
    const transport = this.ensureConnected()
    const result = await transport.request('hub/inspect', { id }) as {
      meta: SessionHeader
      events: SessionEvent[]
    }
    return { meta: result.meta, events: result.events }
  }

  async readFrom(
    id: SessionId,
    fromSeq: number,
    _signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    // Load the full session and filter by seq.
    const loaded = await this.load(id)
    return {
      meta: loaded.meta,
      events: loaded.events.filter(e => e.seq >= fromSeq),
    }
  }

  async list(_signal?: AbortSignal): Promise<SessionHeader[]> {
    const transport = this.ensureConnected()
    const result = await transport.request('hub/list', {}) as {
      sessions: { header: SessionHeader }[]
    }
    return result.sessions.map(s => s.header)
  }

  async listSnapshots(_signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const transport = this.ensureConnected()
    const result = await transport.request('hub/list', {}) as {
      sessions: { header: SessionHeader }[]
    }
    return result.sessions.map(s => ({
      header: s.header,
      revision: { kind: 'remote', seq: s.header.createdAt } as unknown as import('@deepseek-ai/dsh-session-persistence').SessionPersistenceRevision,
    }))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

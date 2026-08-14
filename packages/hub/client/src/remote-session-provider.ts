/**
 * Remote session provider: implements the SessionPersistence seam by
 * forwarding all operations to a remote hub server over WebSocket JSON-RPC.
 *
 * @module @deepseek-ai/dsh-hub-client/remote-session-provider
 */

import WebSocket from 'ws'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence,
  type SessionInspection,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
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
 * A session persistence backend that delegates all operations to a remote
 * harness hub server over WebSocket JSON-RPC.
 */
export class RemoteSessionProvider extends SessionPersistence {
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

  constructor(ctx: Context, config: RemoteHubConfig) {
    super(ctx)
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
    listeners.add(listener)
    return () => {
      this.eventListeners.get(String(sessionId))?.delete(listener)
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

  override locate(_meta: SessionHeader): { kind: string; path: string } | undefined {
    // Remote sessions have no local artifact path.
    return undefined
  }

  override readonly supportsRawArtifacts = false

  override async create(meta: SessionHeader): Promise<void> {
    const transport = this.ensureConnected()
    await transport.request('hub/create', { meta })
  }

  override async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const transport = this.ensureConnected()
    await transport.request('hub/append', { id, events: [...events] })
  }

  override async load(id: SessionId): Promise<SessionInspection> {
    const transport = this.ensureConnected()
    const result = await transport.request('hub/load', { id }) as {
      meta: SessionHeader
      events: SessionEvent[]
    }
    return { meta: result.meta, events: result.events }
  }

  override async inspect(id: SessionId, _signal?: AbortSignal): Promise<SessionInspection> {
    const transport = this.ensureConnected()
    const result = await transport.request('hub/inspect', { id }) as {
      meta: SessionHeader
      events: SessionEvent[]
    }
    return { meta: result.meta, events: result.events }
  }

  override async readFrom(
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

  override async list(_signal?: AbortSignal): Promise<SessionHeader[]> {
    const transport = this.ensureConnected()
    const result = await transport.request('hub/list', {}) as {
      sessions: { header: SessionHeader }[]
    }
    return result.sessions.map(s => s.header)
  }

  override async listSnapshots(_signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
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

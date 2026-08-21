/**
 * Remote session provider: forwards remote session operations over WebSocket
 * JSON-RPC without registering a local session persistence service.
 *
 * @module @deepseek-ai/dsh-hub-client/remote-session-provider
 */

import WebSocket from 'ws'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  JsonRpcWebSocketTransport,
  type JsonRpcTransportPeer,
  type HubHandshakeResult,
  type HubEventNotification,
  type HubHostNotification,
  type HubWorkspaceRef,
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
  private readonly hostListeners = new Set<(notification: HubHostNotification) => void>()

  /** Request access for the provider-owned command client.
   * @param method - the remote method name.
   * @param params - the method parameters.
   * @returns the provider response.
   */
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
      const handshake = await transport.request('hub/handshake', {
        token: this.config.token || undefined,
        version: '0.1.0',
      })
      this.handshakeResult = validateHandshakeResult(handshake)

      this.state = 'connected'

      // Route notifications through the protocol transport so requests and
      // notifications share one parser and one WebSocket lifecycle.
      transport.onNotification((method, params) => {
        if (method === 'hub/event') {
          const notification = params as unknown as HubEventNotification
          const listeners = this.eventListeners.get(eventKey(notification.workspaceId, notification.sessionId))
          if (listeners) {
            for (const listener of listeners) {
              try { listener(notification) } catch { /* ignore */ }
            }
          }
          const wildcard = this.eventListeners.get('*')
          if (wildcard) {
            for (const listener of wildcard) {
              try { listener(notification) } catch { /* ignore */ }
            }
          }
          return
        }
        if (method === 'hub/status') {
          const notification = params as unknown as HubStatusNotification
          for (const listener of this.statusListeners) {
            try { listener(notification) } catch { /* ignore */ }
          }
          return
        }
        if (method === 'hub/host') {
          const notification = params as unknown as HubHostNotification
          for (const listener of this.hostListeners) {
            try { listener(notification) } catch { /* ignore */ }
          }
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

  /** Token used by the authenticated Hub connection, for a sibling Agent connection. */
  get connectionToken(): string { return this.config.token }

  /**
   * Subscribe to events from a specific session.
   * @param workspaceId - workspace that owns the session.
   * @param sessionId - session whose events should be delivered.
   * @param listener - callback invoked for each matching event notification.
   * @returns disposer that removes the listener.
   */
  subscribe(workspaceId: string, sessionId: SessionId, listener: (notification: HubEventNotification) => void): () => void {
    const key = eventKey(workspaceId, sessionId)
    let listeners = this.eventListeners.get(key)
    if (!listeners) {
      listeners = new Set()
      this.eventListeners.set(key, listeners)
    }
    const wasEmpty = listeners.size === 0
    listeners.add(listener)
    if (wasEmpty) {
      void this.request('hub/subscribe', { id: sessionId, workspaceId })
    }
    return () => {
      const current = this.eventListeners.get(key)
      if (current?.delete(listener) && current.size === 0) {
        void this.request('hub/unsubscribe', { id: sessionId, workspaceId })
      }
    }
  }

  /** Subscribe to every remote session event for a host API event bridge.
   * @param listener - callback invoked for each event notification.
   * @returns a disposer for the subscription.
   */
  onEvent(listener: (notification: HubEventNotification) => void): () => void {
    const listeners = this.eventListeners.get('*') ?? new Set()
    const wasEmpty = listeners.size === 0
    this.eventListeners.set('*', listeners)
    listeners.add(listener)
    if (wasEmpty) void this.request('hub/subscribe', {})
    return () => {
      if (!listeners.delete(listener) || listeners.size !== 0) return
      this.eventListeners.delete('*')
      // The Hub has one wildcard unsubscribe operation. Keep it active while
      // a session-specific listener still needs the same connection-wide feed.
      if ([...this.eventListeners].some(([key, value]) => key !== '*' && value.size !== 0)) return
      void this.request('hub/unsubscribe', {})
    }
  }

  /** Subscribe to connection and session status notifications.
   * @param listener - callback invoked for each status notification.
   * @returns a disposer for the subscription.
   */
  onStatus(listener: (notification: HubStatusNotification) => void): () => void {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /** Subscribe to unchanged frames from the remote api.events.host stream.
   * @param listener - callback invoked for each Host notification.
   * @returns a disposer for the subscription.
   */
  onHostFrame(listener: (notification: HubHostNotification) => void): () => void {
    this.hostListeners.add(listener)
    return () => { this.hostListeners.delete(listener) }
  }

  /** Restrict the host stream to workspaces selected by the Web client.
   * @param workspaces - selected endpoint workspace references.
   * @returns the remote subscription response.
   */
  subscribeWorkspaces(workspaces: readonly HubWorkspaceRef[]): Promise<unknown> {
    return this.request('hub/subscribe-workspaces', { workspaces: [...workspaces] })
  }

  /** Ensure the transport is available. */
  private ensureConnected(): JsonRpcTransportPeer {
    if (!this.transport || !this.isConnected) {
      throw new HubConnectionError('not connected to remote hub')
    }
    return this.transport
  }

}

function eventKey(workspaceId: string, sessionId: SessionId): string {
  return `${workspaceId}\u0000${String(sessionId)}`
}

function validateHandshakeResult(value: unknown): HubHandshakeResult {
  if (!isRecord(value)
    || typeof value.endpointId !== 'string'
    || !/^remote:[^\s]+$/u.test(value.endpointId)
    || !isRecord(value.serverInfo)
    || typeof value.serverInfo.name !== 'string'
    || typeof value.serverInfo.version !== 'string'
    || !isRecord(value.capabilities)
    || typeof value.capabilities.subscriptions !== 'boolean'
    || typeof value.capabilities.delete !== 'boolean'
    || (value.capabilities.maxPayloadSize !== undefined
      && (typeof value.capabilities.maxPayloadSize !== 'number'
        || !Number.isInteger(value.capabilities.maxPayloadSize)
        || value.capabilities.maxPayloadSize < 0))) {
    throw new HubConnectionError('invalid hub handshake response')
  }
  return value as unknown as HubHandshakeResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

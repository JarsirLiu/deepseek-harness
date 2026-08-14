/**
 * WebSocket-based JSON-RPC 2.0 transport. Each WebSocket message is one
 * JSON-RPC frame. Frames with `id` and `method` are requests, `id` alone is a
 * response, and `method` alone is a notification. Handler failures become error
 * frames.
 *
 * Both server-side (accepting a WebSocket) and client-side (opening a
 * WebSocket) are supported through the same transport class.
 *
 * @module @deepseek-ai/dsh-hub-protocol/transport
 */

import { randomUUID } from 'node:crypto'
import type WebSocket from 'ws'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'

// Re-export the error class from the SDK protocol for consistency.
export { JsonRpcResponseError }

type JsonRpcId = string | number
type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>
type NotificationHandler = (method: string, params: Record<string, unknown>) => void

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Outbound request and notification surface used by hub clients and servers.
 */
export interface JsonRpcTransportPeer {
  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @returns the result; rejects with {@link JsonRpcResponseError} on an error
   * response, and with a plain `Error` on a write failure or closure.
   */
  request(method: string, params: object): Promise<unknown>
  /**
   * Send a notification; omitted params produce no `params` member.
   * @param method - the JSON-RPC method name.
   * @param params - the optional notification parameters object.
   */
  notify(method: string, params?: object): void
}

/**
 * JSON-RPC 2.0 transport over a single WebSocket connection. Each complete
 * WebSocket message (text) is parsed as one JSON-RPC frame. Supports both
 * server-side (accepted socket) and client-side (opened socket) usage.
 *
 * The transport is single-connection: one WebSocket, one pair of handler
 * registrations. Call {@link start} after wiring handlers and the socket is
 * open; call {@link close} to detach and reject pending requests.
 */
export class JsonRpcWebSocketTransport implements JsonRpcTransportPeer {
  private started = false
  private requestHandler: RequestHandler | undefined
  private notificationHandler: NotificationHandler | undefined
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly onMessage: (data: WebSocket.RawData) => void
  private readonly onClose: (code: number, reason: Buffer) => void
  private readonly onError: (error: Error) => void

  /**
   * @param socket - an open WebSocket connection (both directions).
   */
  constructor(private readonly socket: WebSocket) {
    this.onMessage = (data: WebSocket.RawData): void => {
      this.handleMessage(data)
    }
    this.onClose = (_code: number, _reason: Buffer): void => {
      this.failPending(new Error('WebSocket closed'))
    }
    this.onError = (error: Error): void => {
      this.failPending(error)
    }
  }

  /** Attach message/close/error listeners. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.socket.on('message', this.onMessage)
    this.socket.on('close', this.onClose)
    this.socket.on('error', this.onError)
  }

  /** Detach listeners and reject pending requests. Safe before {@link start}. */
  close(): void {
    this.socket.off('message', this.onMessage)
    this.socket.off('close', this.onClose)
    this.socket.off('error', this.onError)
    this.failPending(new Error('JSON-RPC WebSocket transport closed'))
  }

  /**
   * Install the request handler, replacing any prior handler.
   * @param handler - resolves to the response `result`; a rejection becomes a
   * `-32603` error response carrying the message.
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * Install the notification handler, replacing any prior handler.
   * @param handler - invoked per notification with the method and normalized
   * params object.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /** @inheritdoc */
  request(method: string, params: object): Promise<unknown> {
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write(message)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** @inheritdoc */
  notify(method: string, params?: object): void {
    this.write(
      params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params },
    )
  }

  /** Write a JSON frame to the WebSocket. */
  private write(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message))
  }

  /** Handle an incoming WebSocket message. */
  private handleMessage(data: WebSocket.RawData): void {
    let message: unknown
    try {
      const text = Buffer.isBuffer(data)
        ? data.toString()
        : Array.isArray(data)
          ? Buffer.concat(data).toString()
          : Buffer.from(data).toString()
      message = JSON.parse(text)
    } catch {
      // Malformed peer messages are ignored.
      return
    }
    if (!message || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method

    // Request: has both id and method.
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      void this.handleIncomingRequest(id, method, objectParams(frame.params))
      return
    }
    // Response: has id, no method.
    if (typeof id === 'string' || typeof id === 'number') {
      this.handleIncomingResponse(id, frame)
      return
    }
    // Notification: has method, no id.
    if (typeof method === 'string') {
      this.notificationHandler?.(method, objectParams(frame.params))
    }
  }

  private async handleIncomingRequest(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const handler = this.requestHandler
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`)
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.writeError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  private handleIncomingResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Record<string, unknown>
      pending.reject(new JsonRpcResponseError(
        typeof error.code === 'number' ? error.code : undefined,
        typeof error.message === 'string' ? error.message : 'JSON-RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}

/** Normalize JSON-RPC `params` to a plain object. */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {}
}

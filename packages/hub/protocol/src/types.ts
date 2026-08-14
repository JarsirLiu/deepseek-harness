/**
 * Wire protocol types for the DeepSeek Harness remote hub: the JSON-RPC 2.0
 * request/response pairs and notifications exchanged between a hub server and
 * its remote session clients over WebSocket.
 *
 * @module @deepseek-ai/dsh-hub-protocol/types
 */

import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'

// ── Session operations ─────────────────────────────────────────────

/** Parameters for listing all sessions on the remote hub. */
export interface HubListParams {
  /** Optional filter: only include sessions created after this seq. */
  sinceSeq?: number
}

/** One session header returned by list. */
export interface HubSessionEntry {
  header: SessionHeader
}

/** Result of listing sessions. */
export interface HubListResult {
  sessions: HubSessionEntry[]
}

/** Parameters for creating a new session on the remote hub. */
export interface HubCreateParams {
  meta: SessionHeader
}

/** Result of creating a session. */
export interface HubCreateResult {
  id: SessionId
}

/** Parameters for loading a session's full event log. */
export interface HubLoadParams {
  id: SessionId
}

/** Result of loading a session. */
export interface HubLoadResult {
  meta: SessionHeader
  events: SessionEvent[]
}

/** Parameters for appending events to a session. */
export interface HubAppendParams {
  id: SessionId
  events: SessionEvent[]
}

/** Result of appending events (empty on success). */
export type HubAppendResult = Record<string, never>

/** Parameters for inspecting a session (read-only, no recovery). */
export interface HubInspectParams {
  id: SessionId
}

/** Result of inspecting a session. */
export interface HubInspectResult {
  meta: SessionHeader
  events: SessionEvent[]
}

/** Parameters for deleting a session. */
export interface HubDeleteParams {
  id: SessionId
}

/** Result of deleting a session (empty on success). */
export type HubDeleteResult = Record<string, never>

/** Parameters for subscribing to session events. */
export interface HubSubscribeParams {
  /** Session id to subscribe to; omit for all sessions. */
  id?: SessionId
}

/** A session event notification pushed from the hub. */
export interface HubEventNotification {
  /** Session the event belongs to. */
  sessionId: SessionId
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** A session status notification. */
export interface HubStatusNotification {
  /** Session whose status changed. */
  sessionId: SessionId
  /** The new status. */
  status: 'idle' | 'running' | 'created' | 'disposed'
}

// ── Hub protocol capability advertisement ──────────────────────────

/** Features the hub server supports. */
export interface HubCapabilities {
  /** Whether the hub supports event subscriptions. */
  subscriptions: boolean
  /** Whether the hub supports session deletion. */
  delete: boolean
  /** Maximum payload size in bytes, or undefined for unlimited. */
  maxPayloadSize?: number
}

/** Parameters for the handshake. */
export interface HubHandshakeParams {
  /** Client identity token. */
  token?: string
  /** Client version string. */
  version?: string
}

/** Result of the handshake. */
export interface HubHandshakeResult {
  /** Server identity. */
  serverInfo: { name: string; version: string }
  /** Server capabilities. */
  capabilities: HubCapabilities
}

/** Connection states exposed by the host-side hub client. */
export type HubConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Status response served by the host-side hub client web endpoint. */
export interface HubStatusResponse {
  /** Current client connection state. */
  status: HubConnectionState
  /** Whether the client has an open hub connection. */
  isConnected: boolean
  /** Configured hub server URI. */
  uri: string
  /** Connected server identity, or null before a successful handshake. */
  serverInfo: { name: string; version: string } | null
}

// ── JSON-RPC request/notification maps ─────────────────────────────

/** Server-to-client notifications. */
export interface HubNotificationMap {
  'hub/event': HubEventNotification
  'hub/status': HubStatusNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HubRequestMap {
  'hub/handshake': { params: HubHandshakeParams; result: HubHandshakeResult }
  'hub/list': { params: HubListParams; result: HubListResult }
  'hub/create': { params: HubCreateParams; result: HubCreateResult }
  'hub/load': { params: HubLoadParams; result: HubLoadResult }
  'hub/append': { params: HubAppendParams; result: HubAppendResult }
  'hub/inspect': { params: HubInspectParams; result: HubInspectResult }
  'hub/delete': { params: HubDeleteParams; result: HubDeleteResult }
  'hub/subscribe': { params: HubSubscribeParams; result: HubAppendResult }
  'hub/unsubscribe': { params: HubSubscribeParams; result: HubAppendResult }
}

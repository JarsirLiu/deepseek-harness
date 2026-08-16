/**
 * Wire protocol types for the DeepSeek Harness remote hub: the JSON-RPC 2.0
 * request/response pairs and notifications exchanged between a hub server and
 * its remote session clients over WebSocket.
 *
 * @module @deepseek-ai/dsh-hub-protocol/types
 */

import type { SessionEvent, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'

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

/** One directory registered on the remote Hub. */
export interface HubWorkspaceEntry {
  /** Stable workspace identifier owned by the remote device. */
  id: string
  /** Display name for the remote workspace. */
  title: string
  /** Canonical path on the remote device; never used as a local path. */
  path: string
  /** Sessions currently attached to this workspace, projected by the owner. */
  sessions: HubWorkspaceSession[]
}

/** Remote session summary projected by the owning Hub device. */
export interface HubWorkspaceSession {
  /** Stable identity of the remote Hub endpoint. */
  endpointId: `remote:${string}`
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  title?: string
  agentPreset?: string
  parentSessionId?: SessionId
  origin?: 'subagent'
}

/** Result of listing workspaces on the remote Hub. */
export interface HubWorkspaceListResult {
  /** Stable identity of the Hub endpoint that owns these workspaces. */
  endpointId: `remote:${string}`
  workspaces: HubWorkspaceEntry[]
}

/** Parameters for creating a session in a remote workspace. */
export interface HubWorkspaceSessionCreateParams {
  workspaceId: string
}

/** Result of creating a session in a remote workspace. */
export interface HubWorkspaceSessionCreateResult {
  sessionId: SessionId
}

/** Parameters for a remote direct-child catalog request. */
export interface HubSubagentListParams { parentSessionId: SessionId }
/** Parameters shared by remote subagent transcript and control requests. */
export interface HubSubagentAddress { parentSessionId: SessionId; childSessionId: SessionId; mode: 'one-shot' | 'continuable' }

/** Model selection forwarded to the owning remote session. */
export interface HubSessionModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
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

/** Parameters for queueing one user message on a remote Agent. */
export interface HubAgentMessageParams {
  id: SessionId
  message: UserMessage
  mode?: 'queue' | 'steer'
}

/** Result of accepting a remote Agent message. */
export interface HubAgentMessageResult {
  accepted: true
}

/** Parameters for cancelling the active turn of a remote Agent. */
export interface HubAgentCancelParams {
  id: SessionId
  cause?: 'user' | 'shutdown' | 'remote'
}

/** Parameters for forwarding the official Sessions API prompt request. */
export interface HubSessionPromptParams {
  id: SessionId
  content: unknown[]
  mode: 'queue' | 'steer'
  clientTimeZone?: string
}

/** Result of cancelling a remote Agent turn. */
export type HubAgentCancelResult = Record<string, never>

/** Parameters for subscribing to session events. */
export interface HubSubscribeParams {
  /** Session id to subscribe to; omit for all sessions. */
  id?: SessionId
}

/** A session event notification pushed from the hub. */
export interface HubEventNotification {
  /** Stable endpoint identity assigned by the publishing Hub. */
  endpointId: `remote:${string}`
  /** Session the event belongs to. */
  sessionId: SessionId
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** One official api.events.host frame forwarded by the owning Hub. */
export interface HubHostNotification {
  /** Stable endpoint identity assigned by the publishing Hub. */
  endpointId: `remote:${string}`
  /** The unchanged payload emitted by api.events.host. */
  frame: HostFrame
}

/** A session status notification. */
export interface HubStatusNotification {
  /** Stable endpoint identity assigned by the publishing Hub. */
  endpointId: `remote:${string}`
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
  /** Stable identity of the remote Hub endpoint. */
  endpointId: `remote:${string}`
  /** Server identity. */
  serverInfo: { name: string; version: string }
  /** Server capabilities. */
  capabilities: HubCapabilities
}

/** Connection states exposed by the host-side hub client. */
export type HubConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** Status response served by the host-side hub client web endpoint. */
export interface HubStatusResponse {
  /** Stable client-configured identity of the remote endpoint. */
  endpointId: `remote:${string}`
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
  'hub/host': HubHostNotification
  'hub/status': HubStatusNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HubRequestMap {
  'hub/handshake': { params: HubHandshakeParams; result: HubHandshakeResult }
  'hub/list': { params: HubListParams; result: HubListResult }
  'hub/workspaces': { params: { workspaceIds?: string[] }; result: HubWorkspaceListResult }
  'hub/subscribe': { params: HubSubscribeParams; result: HubAppendResult }
  'hub/unsubscribe': { params: HubSubscribeParams; result: HubAppendResult }
}

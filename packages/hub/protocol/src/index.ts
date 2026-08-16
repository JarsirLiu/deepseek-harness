/**
 * Shared wire protocol for the DeepSeek Harness remote hub: the WebSocket
 * JSON-RPC transport and the named request, result, and notification types
 * spoken between a hub server and its remote session clients.
 *
 * @module @deepseek-ai/dsh-hub-protocol
 */

export { JsonRpcWebSocketTransport, JsonRpcResponseError } from './transport.ts'
export type { JsonRpcTransportPeer } from './transport.ts'
export type {
  HubAppendParams,
  HubAppendResult,
  HubAgentCancelParams,
  HubAgentCancelResult,
  HubAgentMessageParams,
  HubAgentMessageResult,
  HubCapabilities,
  HubConnectionState,
  HubCreateParams,
  HubCreateResult,
  HubDeleteParams,
  HubDeleteResult,
  HubEventNotification,
  HubHostNotification,
  HubHandshakeParams,
  HubHandshakeResult,
  HubInspectParams,
  HubInspectResult,
  HubListParams,
  HubListResult,
  HubWorkspaceEntry,
  HubWorkspaceSession,
  HubWorkspaceListResult,
  HubLoadParams,
  HubLoadResult,
  HubNotificationMap,
  HubRequestMap,
  HubSessionEntry,
  HubStatusNotification,
  HubStatusResponse,
  HubSubscribeParams,
} from './types.ts'

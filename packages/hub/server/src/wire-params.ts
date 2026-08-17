/**
 * Validation for untrusted Hub JSON-RPC parameters.
 *
 * @module @deepseek-ai/dsh-hub-server/wire-params
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  HubAgentHostEventParams,
  HubAgentRegisterParams,
  HubApiRequestParams,
  HubEventNotification,
  HubWorkspaceEntry,
  HubWorkspaceRef,
} from '@deepseek-ai/dsh-hub-protocol'

/** Validate an explicit remote endpoint identity.
 * @param endpointId Candidate identity.
 * @returns The validated identity.
 */
export function requireEndpointId(endpointId: `remote:${string}`): `remote:${string}` {
  if (!isEndpointId(endpointId)) throw new Error('invalid Hub endpoint identity')
  return endpointId
}

/** Parse a Hub API forwarding request. @param params Untrusted request parameters. @returns Typed API request. */
export function parseApiRequestParams(params: Record<string, unknown>): HubApiRequestParams {
  if (!isEndpointId(params.endpointId) || !isNonEmptyString(params.workspaceId)
    || !isNonEmptyString(params.method) || !isRecord(params.payload)) {
    throw new Error('invalid Hub API request')
  }
  return { endpointId: params.endpointId, workspaceId: params.workspaceId, method: params.method, payload: params.payload }
}

/** Parse Endpoint Agent registration parameters. @param params Untrusted request parameters. @returns Typed registration parameters. */
export function parseAgentRegisterParams(params: Record<string, unknown>): HubAgentRegisterParams {
  if (!isEndpointId(params.endpointId) || !isNonEmptyString(params.token)
    || !isServerInfo(params.serverInfo) || (params.version !== undefined && typeof params.version !== 'string')) {
    throw new Error('invalid Endpoint Agent registration')
  }
  return {
    endpointId: params.endpointId,
    token: params.token,
    ...(params.version === undefined ? {} : { version: params.version }),
    serverInfo: params.serverInfo,
    workspaces: parseWorkspaces(params.workspaces),
  }
}

/** Parse an Endpoint Agent workspace publication. @param params Untrusted request parameters. @returns Typed workspace directory. */
export function parseWorkspacePublishParams(params: Record<string, unknown>): { workspaces: HubWorkspaceEntry[] } {
  return { workspaces: parseWorkspaces(params.workspaces) }
}

/** Parse a Client workspace subscription. @param params Untrusted request parameters. @returns Typed optional subscription. */
export function parseWorkspaceSubscriptionParams(params: Record<string, unknown>): { workspaces?: HubWorkspaceRef[] } {
  if (params.workspaces === undefined) return {}
  if (!Array.isArray(params.workspaces)) throw new Error('invalid Hub workspace subscription')
  return { workspaces: params.workspaces.map(parseWorkspaceRef) }
}

/** Parse a Host-stream notification from an Endpoint Agent.
 * @param params Untrusted notification parameters.
 * @returns Typed notification.
 */
export function parseAgentHostEventParams(params: Record<string, unknown>): HubAgentHostEventParams {
  if (!isEndpointId(params.endpointId)
    || (params.workspaceId !== null && !isNonEmptyString(params.workspaceId))
    || !isRecord(params.frame) || typeof params.frame.type !== 'string') {
    throw new Error('invalid Endpoint Agent Host event')
  }
  return { endpointId: params.endpointId, workspaceId: params.workspaceId, frame: params.frame as HubAgentHostEventParams['frame'] }
}

/** Parse a session-stream notification from an Endpoint Agent.
 * @param params Untrusted notification parameters.
 * @returns Typed notification.
 */
export function parseAgentEventNotification(params: Record<string, unknown>): HubEventNotification {
  if (!isEndpointId(params.endpointId) || !isNonEmptyString(params.workspaceId)
    || !isNonEmptyString(params.sessionId) || !isRecord(params.event) || typeof params.event.type !== 'string') {
    throw new Error('invalid Endpoint Agent session event')
  }
  return {
    endpointId: params.endpointId,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId as SessionId,
    event: params.event as never,
  }
}

/** Parse an Agent-owned workspace directory. @param value Untrusted directory value. @returns Typed directory. */
export function parseWorkspaces(value: unknown): HubWorkspaceEntry[] {
  if (!Array.isArray(value)) throw new Error('invalid Endpoint Agent workspace directory')
  return value.map((workspace) => {
    if (!isRecord(workspace) || !isEndpointId(workspace.endpointId) || !isNonEmptyString(workspace.id)
      || typeof workspace.title !== 'string' || typeof workspace.path !== 'string' || !Array.isArray(workspace.sessions)) {
      throw new Error('invalid Endpoint Agent workspace directory')
    }
    return { ...workspace, sessions: workspace.sessions.map(parseWorkspaceSession) } as HubWorkspaceEntry
  })
}

function parseWorkspaceRef(workspace: unknown): HubWorkspaceRef {
  if (!isRecord(workspace) || !isEndpointId(workspace.endpointId) || !isNonEmptyString(workspace.workspaceId)) {
    throw new Error('invalid Hub workspace subscription')
  }
  return { endpointId: workspace.endpointId, workspaceId: workspace.workspaceId }
}

function parseWorkspaceSession(session: unknown): HubWorkspaceEntry['sessions'][number] {
  if (!isRecord(session) || !isEndpointId(session.endpointId) || !isNonEmptyString(session.sessionId)
    || typeof session.updatedAt !== 'number' || !Number.isFinite(session.updatedAt)
    || typeof session.running !== 'boolean' || typeof session.blank !== 'boolean') {
    throw new Error('invalid Endpoint Agent workspace directory')
  }
  return {
    ...session,
    endpointId: session.endpointId,
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    running: session.running,
    blank: session.blank,
  } as HubWorkspaceEntry['sessions'][number]
}

function isEndpointId(value: unknown): value is `remote:${string}` {
  return typeof value === 'string' && /^remote:[^\s]+$/u.test(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isServerInfo(value: unknown): value is { name: string; version: string } {
  return isRecord(value) && isNonEmptyString(value.name) && isNonEmptyString(value.version)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

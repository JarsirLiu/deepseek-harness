/** Endpoint Agent connection that registers one Host with a Hub listener. */

import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import {
  JsonRpcWebSocketTransport,
  hostFrameWorkspaceIds,
  isEndpointWideHostFrame,
  type HubWorkspaceOwnershipEntry,
  type HubApiRequestParams,
  type HubAgentHostEventParams,
  type HubAgentRegisterResult,
  type HubEndpointSummary,
  type JsonRpcTransportPeer,
} from '@deepseek-ai/dsh-hub-protocol'
import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Configuration for an Endpoint Agent connection. */
export interface HubEndpointAgentConfig {
  /** Hub listener WebSocket URI. */
  uri: string
  /** Stable identity owned by this endpoint. */
  endpointId: `remote:${string}`
  /** Endpoint-to-Hub registration credential. */
  token: string
  /** Identity of the Host serving this endpoint. */
  serverInfo: { name: string; version: string }
  /** Host API implementation used for requests forwarded by the Hub. */
  apiProxy: Pick<ApiProxy, 'events'> & Record<string, Record<string, (request: unknown) => Promise<unknown>>>
}

/** Outbound connection used by a Host to register with a Hub listener. */
export class HubEndpointAgent {
  private ws: WebSocket | null = null
  private transport: JsonRpcTransportPeer | null = null
  private registration: HubAgentRegisterResult | null = null
  private workspaces = new Map<string, HubWorkspaceOwnershipEntry>()
  private hostAbortController: AbortController | null = null
  private hostStreamDone: Promise<void> | null = null
  private hostStreamError: unknown = null

  constructor(private readonly config: HubEndpointAgentConfig) {}

  /** Register this endpoint and publish its initial workspace directory.
   * @param workspaces - complete workspace directory owned by this endpoint.
   * @returns the registration result returned by the Hub listener.
   */
  async connect(workspaces: HubEndpointSummary['workspaces']): Promise<HubAgentRegisterResult> {
    if (this.transport !== null) throw new Error('Endpoint Agent is already connected')
    const ws = new WebSocket(this.config.uri)
    this.ws = ws
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => { reject(error) }
        ws.once('open', resolve)
        ws.once('error', onError)
      })
      const transport = new JsonRpcWebSocketTransport(ws)
      transport.onRequest((method, params) => {
        if (method !== 'hub/api/request') throw new Error(`unknown Endpoint Agent method: ${method}`)
        return this.handleApiRequest(parseApiRequestParams(params))
      })
      transport.start()
      this.transport = transport
      const result = await transport.request('hub/agent/register', {
        endpointId: this.config.endpointId,
        token: this.config.token,
        serverInfo: this.config.serverInfo,
        workspaces: workspaces.map(workspace => ({ ...workspace, endpointId: this.config.endpointId })),
      }) as HubAgentRegisterResult
      if (!isRegisterResult(result, this.config.endpointId)) throw new Error('invalid Endpoint Agent registration response')
      this.registration = result
      this.setWorkspaces(workspaces)
      this.startHostBridge()
      return result
    } catch (error) {
      await this.disconnect()
      throw error
    }
  }

  /** Publish a complete replacement workspace directory to the Hub.
   * @param workspaces - complete replacement directory owned by this endpoint.
   */
  async publishWorkspaces(workspaces: HubEndpointSummary['workspaces']): Promise<void> {
    const transport = this.transport
    if (transport === null) throw new Error('Endpoint Agent is not connected')
    await transport.request('hub/agent/publish-workspaces', {
      workspaces: workspaces.map(workspace => ({ ...workspace, endpointId: this.config.endpointId })),
    })
    this.setWorkspaces(workspaces)
  }

  /** Publish one unchanged Host API frame with explicit workspace ownership.
   * @param workspaceId - workspace that owns the frame.
   * @param frame - unchanged Host API frame.
   */
  publishHostEvent(workspaceId: string | null, frame: HubAgentHostEventParams['frame']): void {
    const transport = this.transport
    if (transport === null) throw new Error('Endpoint Agent is not connected')
    if (workspaceId !== null && !this.workspaces.has(workspaceId)) {
      throw new Error(`Endpoint Agent workspace unavailable: ${workspaceId}`)
    }
    const event: HubAgentHostEventParams = {
      endpointId: this.config.endpointId,
      workspaceId,
      frame,
    }
    transport.notify('hub/agent/host-event', event)
  }

  /** Disconnect this Endpoint Agent from the Hub. */
  async disconnect(): Promise<void> {
    this.hostAbortController?.abort()
    await this.hostStreamDone
    this.ws?.close()
    this.transport = null
    this.ws = null
    this.registration = null
    this.workspaces.clear()
    this.hostAbortController = null
    this.hostStreamDone = null
    this.hostStreamError = null
  }

  /** Registration response from the current connection. */
  get registrationResult(): HubAgentRegisterResult | null { return this.registration }

  /** Failure that ended the local Host event bridge, or null while it is healthy. */
  get hostStreamFailure(): unknown { return this.hostStreamError }

  private async handleApiRequest(params: HubApiRequestParams): Promise<unknown> {
    if (params.endpointId !== this.config.endpointId) throw new Error(`Endpoint Agent identity mismatch: ${params.endpointId}`)
    if (!this.workspaces.has(params.workspaceId)) throw new Error(`Endpoint Agent workspace unavailable: ${params.workspaceId}`)
    const allowed = new Set([
      'session.list', 'session.create', 'session.history', 'session.models', 'session.selectModel',
      'session.rename', 'session.fork', 'session.prompt', 'session.attachment', 'session.updateQueue',
      'session.cancel', 'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
      'workspace.rename', 'workspace.delete', 'workspace.insertBefore', 'workspace.insertSessionBefore',
      'workspace.archiveSession',
    ])
    if (!allowed.has(params.method)) throw new Error(`unsupported Endpoint Agent API method: ${params.method}`)
    const [domain, operation] = params.method.split('.')
    const handler = domain === undefined || operation === undefined
      ? undefined
      : this.config.apiProxy[domain === 'session' ? 'sessions' : domain === 'subagent' ? 'subagents' : domain]?.[operation]
    if (handler === undefined) throw new Error(`unsupported Endpoint Agent API method: ${params.method}`)
    return await handler({ rpcId: `hub-agent-api-${randomUUID()}`, payload: params.payload })
  }

  private setWorkspaces(workspaces: HubEndpointSummary['workspaces']): void {
    this.workspaces = new Map(workspaces.map(workspace => [workspace.id, {
      id: workspace.id,
      path: workspace.path,
      sessionIds: workspace.sessions.map(session => session.sessionId),
    }]))
  }

  private startHostBridge(): void {
    const controller = new AbortController()
    this.hostAbortController = controller
    this.hostStreamDone = (async () => {
      try {
        for await (const envelope of this.config.apiProxy.events.host({ rpcId: `hub-agent-host-${randomUUID()}` as RpcId, payload: {} }, controller.signal)) {
          const owners = hostFrameWorkspaceIds(envelope.payload, [...this.workspaces.values()])
          if (isSessionHostFrame(envelope.payload) && owners.length !== 1) {
            throw new Error(`Endpoint Agent cannot uniquely determine Host frame workspace: ${envelope.payload.type}`)
          }
          if (owners.length === 0 && !isEndpointWideHostFrame(envelope.payload)) {
            throw new Error(`Endpoint Agent cannot determine Host frame workspace: ${envelope.payload.type}`)
          }
          if (owners.length === 0) this.publishHostEvent(null, envelope.payload)
          else for (const workspaceId of owners) this.publishHostEvent(workspaceId, envelope.payload)
          this.updateWorkspaceOwnership(envelope.payload, owners)
        }
      } catch (error) {
        if (!controller.signal.aborted) this.hostStreamError = error
      }
    })()
  }

  private updateWorkspaceOwnership(frame: import('@deepseek-ai/dsh-host-apiproxy/api').HostFrame, owners: readonly string[]): void {
    if (frame.type === 'host/session-added') {
      for (const workspaceId of owners) {
        const workspace = this.workspaces.get(workspaceId)
        if (workspace !== undefined && !workspace.sessionIds.includes(frame.sessionId)) {
          workspace.sessionIds = [...workspace.sessionIds, frame.sessionId]
        }
      }
    } else if (frame.type === 'host/session-removed') {
      for (const workspace of this.workspaces.values()) {
        workspace.sessionIds = workspace.sessionIds.filter(sessionId => sessionId !== frame.sessionId)
      }
    } else if (frame.type === 'host/workspace-changed') {
      const workspace = this.workspaces.get(frame.workspace.workspaceId)
      if (workspace !== undefined) {
        workspace.path = frame.workspace.path
        workspace.sessionIds = [...frame.workspace.sessionIds]
      }
    } else if (frame.type === 'host/workspace-removed') {
      this.workspaces.delete(frame.workspaceId)
    }
  }
}

function isSessionHostFrame(frame: import('@deepseek-ai/dsh-host-apiproxy/api').HostFrame): boolean {
  return frame.type === 'host/session-added'
    || frame.type === 'host/session-removed'
    || frame.type === 'host/session-status'
    || frame.type === 'host/agent-error'
}

function parseApiRequestParams(params: Record<string, unknown>): HubApiRequestParams {
  if (typeof params.endpointId !== 'string' || !/^remote:[^\s]+$/u.test(params.endpointId)
    || typeof params.workspaceId !== 'string' || params.workspaceId === ''
    || typeof params.method !== 'string' || params.method === ''
    || typeof params.payload !== 'object' || params.payload === null || Array.isArray(params.payload)) {
    throw new Error('invalid Endpoint Agent API request')
  }
  return {
    endpointId: params.endpointId as `remote:${string}`,
    workspaceId: params.workspaceId,
    method: params.method,
    payload: params.payload as Record<string, unknown>,
  }
}

function isRegisterResult(value: unknown, endpointId: `remote:${string}`): value is HubAgentRegisterResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const brokerInfo = record.brokerInfo
  return record.endpointId === endpointId
    && typeof brokerInfo === 'object'
    && brokerInfo !== null
    && !Array.isArray(brokerInfo)
    && typeof (brokerInfo as Record<string, unknown>).name === 'string'
    && typeof (brokerInfo as Record<string, unknown>).version === 'string'
}

/** Endpoint Agent connection that registers one Host with a Hub listener. */

import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import {
  JsonRpcWebSocketTransport,
  type HubApiRequestParams,
  type HubAgentHostEventParams,
  type HubAgentRegisterResult,
  type HubEndpointSummary,
  type JsonRpcTransportPeer,
} from '@deepseek-ai/dsh-hub-protocol'

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
  apiProxy: Record<string, Record<string, (request: unknown) => Promise<unknown>>>
}

/** Outbound connection used by a Host to register with a Hub listener. */
export class HubEndpointAgent {
  private ws: WebSocket | null = null
  private transport: JsonRpcTransportPeer | null = null
  private registration: HubAgentRegisterResult | null = null
  private workspaces = new Set<string>()

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
      this.workspaces = new Set(workspaces.map(workspace => workspace.id))
      return result
    } catch (error) {
      this.disconnect()
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
    this.workspaces = new Set(workspaces.map(workspace => workspace.id))
  }

  /** Publish one unchanged Host API frame with explicit workspace ownership.
   * @param workspaceId - workspace that owns the frame.
   * @param frame - unchanged Host API frame.
   */
  publishHostEvent(workspaceId: string, frame: HubAgentHostEventParams['frame']): void {
    const transport = this.transport
    if (transport === null) throw new Error('Endpoint Agent is not connected')
    if (!this.workspaces.has(workspaceId)) throw new Error(`Endpoint Agent workspace unavailable: ${workspaceId}`)
    const event: HubAgentHostEventParams = {
      endpointId: this.config.endpointId,
      workspaceId,
      frame,
    }
    transport.notify('hub/agent/host-event', event)
  }

  /** Disconnect this Endpoint Agent from the Hub. */
  disconnect(): void {
    this.ws?.close()
    this.transport = null
    this.ws = null
    this.registration = null
    this.workspaces.clear()
  }

  /** Registration response from the current connection. */
  get registrationResult(): HubAgentRegisterResult | null { return this.registration }

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

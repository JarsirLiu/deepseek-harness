/** Endpoint Agent connection that registers one Host with a Hub listener. */

import WebSocket from 'ws'
import {
  JsonRpcWebSocketTransport,
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
}

/** Outbound connection used by a Host to register with a Hub listener. */
export class HubEndpointAgent {
  private ws: WebSocket | null = null
  private transport: JsonRpcTransportPeer | null = null
  private registration: HubAgentRegisterResult | null = null

  constructor(private readonly config: HubEndpointAgentConfig) {}

  /** Register this endpoint and publish its initial workspace directory. */
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
      transport.start()
      this.transport = transport
      const result = await transport.request('hub/agent/register', {
        endpointId: this.config.endpointId,
        token: this.config.token,
        serverInfo: this.config.serverInfo,
        workspaces,
      }) as HubAgentRegisterResult
      if (!isRegisterResult(result, this.config.endpointId)) throw new Error('invalid Endpoint Agent registration response')
      this.registration = result
      return result
    } catch (error) {
      this.disconnect()
      throw error
    }
  }

  /** Publish a complete replacement workspace directory to the Hub. */
  async publishWorkspaces(workspaces: HubEndpointSummary['workspaces']): Promise<void> {
    const transport = this.transport
    if (transport === null) throw new Error('Endpoint Agent is not connected')
    await transport.request('hub/agent/publish-workspaces', { workspaces })
  }

  /** Disconnect this Endpoint Agent from the Hub. */
  disconnect(): void {
    this.ws?.close()
    this.transport = null
    this.ws = null
    this.registration = null
  }

  /** Registration response from the current connection. */
  get registrationResult(): HubAgentRegisterResult | null { return this.registration }
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

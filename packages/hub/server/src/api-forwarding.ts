/** Forwards endpoint-qualified Hub API requests to the owning Host API. */

import type { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HubApiRequestParams, HubWorkspaceEntry } from '@deepseek-ai/dsh-hub-protocol'

export type ApiProxyMethod = (request: { rpcId: RpcId; payload: Record<string, unknown> }) => Promise<{ result: unknown }>

/** Dependencies owned by the Hub server connection layer. */
export interface ApiForwardingDependencies {
  endpointId: `remote:${string}`
  localWorkspaceIds: readonly string[]
  localApi?: Record<string, Record<string, ApiProxyMethod>> | undefined
  agents: readonly {
    endpointId?: `remote:${string}` | undefined
    workspaces?: readonly HubWorkspaceEntry[] | undefined
    request(method: string, params: HubApiRequestParams): Promise<unknown>
  }[]
  createRpcId(): RpcId
}

const allowedMethods = new Set([
  'session.list', 'session.create', 'session.history', 'session.models', 'session.selectModel',
  'session.rename', 'session.fork', 'session.prompt', 'session.attachment', 'session.updateQueue',
  'session.cancel', 'subagent.list', 'subagent.history', 'subagent.prompt', 'subagent.interrupt',
  'workspace.rename', 'workspace.delete', 'workspace.insertBefore', 'workspace.insertSessionBefore',
  'workspace.archiveSession',
])

/** Forward one request without changing the official API result. */
export async function forwardApiRequest(params: HubApiRequestParams, dependencies: ApiForwardingDependencies): Promise<unknown> {
  if (params.endpointId !== dependencies.endpointId) {
    const agent = dependencies.agents.find(candidate => candidate.endpointId === params.endpointId)
    if (agent === undefined) throw new Error(`remote endpoint unavailable: ${params.endpointId}`)
    if (!agent.workspaces?.some(workspace => workspace.id === params.workspaceId)) {
      throw new Error(`remote workspace unavailable: ${params.endpointId}/${params.workspaceId}`)
    }
    return await agent.request('hub/api/request', params)
  }
  if (!dependencies.localWorkspaceIds.includes(params.workspaceId)) {
    throw new Error(`local workspace unavailable: ${params.workspaceId}`)
  }
  if (!allowedMethods.has(params.method)) throw new Error(`unsupported remote API method: ${params.method}`)
  const [domain, operation] = params.method.split('.') as [string, string]
  // Every allowed method is declared as `domain.operation` above.
  const apiDomain = domain === 'session' ? 'sessions' : domain === 'subagent' ? 'subagents' : domain
  const handler = dependencies.localApi?.[apiDomain]?.[operation]
  if (handler === undefined) throw new Error(`remote API method is unavailable: ${params.method}`)
  return (await handler({ rpcId: dependencies.createRpcId(), payload: params.payload })).result
}

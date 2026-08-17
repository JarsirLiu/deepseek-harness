/** Three-process Endpoint Agent fixture for Hub registration and discovery. */

import { HubEndpointAgent } from '../../src/endpoint-agent.ts'
import type { HubEndpointSummary } from '@deepseek-ai/dsh-hub-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'

const port = process.argv[2]
if (port === undefined) throw new Error('Hub Agent fixture requires a port')
const endpointId = (process.argv[3] ?? 'remote:registered-agent') as `remote:${string}`
const workspaceIds = (process.argv[4] ?? 'workspace-agent').split(',').filter(id => id !== '')
if (workspaceIds.length === 0) throw new Error('Hub Agent fixture requires at least one workspace')

const agent = new HubEndpointAgent({
  uri: `ws://127.0.0.1:${port}/hub`,
  endpointId,
  token: 'agent-secret',
  serverInfo: { name: 'registered-agent', version: '0.1.0' },
  apiProxy: {
    sessions: {
      history: async (request: unknown) => ({ ok: true, value: { request, source: endpointId } }),
    },
  },
})
const workspaces: HubEndpointSummary['workspaces'] = workspaceIds.map(workspaceId => ({
  endpointId,
  id: workspaceId,
  title: `${endpointId} ${workspaceId}`,
  path: `D:/agent/${workspaceId}`,
  sessions: [{
    endpointId,
    sessionId: 'shared-session' as SessionId,
    updatedAt: 1,
    running: false,
    blank: false,
  }],
}))

await agent.connect(workspaces)
console.log(JSON.stringify({ type: 'ready', endpointId: agent.registrationResult?.endpointId ?? null }))

process.on('SIGTERM', () => {
  agent.disconnect()
  process.exit(0)
})
process.stdin.resume()

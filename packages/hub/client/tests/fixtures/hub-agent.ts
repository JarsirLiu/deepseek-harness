/** Three-process Endpoint Agent fixture for Hub registration and discovery. */

import { HubEndpointAgent } from '../../src/endpoint-agent.ts'

const port = process.argv[2]
if (port === undefined) throw new Error('Hub Agent fixture requires a port')

const agent = new HubEndpointAgent({
  uri: `ws://127.0.0.1:${port}/hub`,
  endpointId: 'remote:registered-agent',
  token: 'agent-secret',
  serverInfo: { name: 'registered-agent', version: '0.1.0' },
})
const workspaces = [{
  id: 'workspace-agent',
  title: 'Registered Agent Workspace',
  path: 'D:/agent/project',
  sessions: [],
}]

await agent.connect(workspaces)
console.log(JSON.stringify({ type: 'ready', endpointId: agent.registrationResult?.endpointId ?? null }))

process.on('SIGTERM', () => {
  agent.disconnect()
  process.exit(0)
})
process.stdin.resume()

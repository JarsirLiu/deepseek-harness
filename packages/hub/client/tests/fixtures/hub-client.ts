/** Two-process Hub Client fixture for the endpoint identity integration test. */

import { RemoteSessionProvider } from '../../src/remote-session-provider.ts'

const uri = process.argv[2]
if (uri === undefined) throw new Error('Hub Client fixture requires a WebSocket URI')
const requestEndpointId = process.argv[3] as `remote:${string}` | undefined
const requestWorkspaceId = process.argv[4]

const provider = new RemoteSessionProvider({} as never, { uri })
try {
  await provider.connect()
  const endpoints = await provider.request('hub/list-endpoints', {})
  const workspaces = await provider.request('hub/workspaces', {})
  const request = requestEndpointId === undefined || requestWorkspaceId === undefined
    ? undefined
    : await provider.request('hub/api/request', {
      endpointId: requestEndpointId,
      workspaceId: requestWorkspaceId,
      method: 'session.history',
      payload: { sessionId: 'shared-session' },
    })
  console.log(JSON.stringify({
    type: 'ready',
    endpointId: provider.connectedServerInfo?.endpointId ?? null,
    serverInfo: provider.connectedServerInfo?.serverInfo ?? null,
    endpoints,
    workspaces,
    ...(request === undefined ? {} : { request }),
  }))
} catch (error) {
  console.log(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}

process.stdin.resume()

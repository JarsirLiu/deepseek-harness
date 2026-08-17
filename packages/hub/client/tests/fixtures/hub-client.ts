/** Two-process Hub Client fixture for the endpoint identity integration test. */

import { RemoteSessionProvider } from '../../src/remote-session-provider.ts'

const uri = process.argv[2]
if (uri === undefined) throw new Error('Hub Client fixture requires a WebSocket URI')
const requestEndpointId = process.argv[3] as `remote:${string}` | undefined
const requestWorkspaceId = process.argv[4]
const subscribeHost = process.argv[5] === 'subscribe-host'
const subscribeEvents = process.argv[5] === 'subscribe-events'
const runBusinessScenario = process.argv[6] === 'business'

const provider = new RemoteSessionProvider({} as never, { uri })
try {
  await provider.connect()
  const endpoints = await provider.request('hub/list-endpoints', {})
  const workspaces = await provider.request('hub/workspaces', requestEndpointId === undefined || requestWorkspaceId === undefined
    ? {}
    : { workspaces: [{ endpointId: requestEndpointId, workspaceId: requestWorkspaceId }] })
  const hostFrames: unknown[] = []
  const eventFrames: unknown[] = []
  const disposeHost = subscribeHost
    ? provider.onHostFrame((notification) => { hostFrames.push(notification) })
    : undefined
  const disposeEvents = subscribeEvents
    ? provider.onEvent((notification) => { eventFrames.push(notification) })
    : undefined
  if ((subscribeHost || subscribeEvents) && requestEndpointId !== undefined && requestWorkspaceId !== undefined) {
    await provider.subscribeWorkspaces([{ endpointId: requestEndpointId, workspaceId: requestWorkspaceId }])
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, 2_000)
      const check = (): void => {
        if (hostFrames.length > 0 || eventFrames.length > 0) { clearTimeout(deadline); resolve(); return }
        setTimeout(check, 10).unref()
      }
      check()
    })
  }
  const request = requestEndpointId === undefined || requestWorkspaceId === undefined
    ? undefined
    : await provider.request('hub/api/request', {
      endpointId: requestEndpointId,
      workspaceId: requestWorkspaceId,
      method: 'session.history',
      payload: { sessionId: 'shared-session' },
    })
  const business = !runBusinessScenario || requestEndpointId === undefined || requestWorkspaceId === undefined
    ? undefined
    : await Promise.all([
      provider.request('hub/api/request', {
        endpointId: requestEndpointId, workspaceId: requestWorkspaceId,
        method: 'session.create', payload: { workspaceId: requestWorkspaceId, sessionId: 'created-session' },
      }),
      provider.request('hub/api/request', {
        endpointId: requestEndpointId, workspaceId: requestWorkspaceId,
        method: 'session.prompt', payload: { sessionId: 'shared-session', mode: 'queue', content: [{ type: 'text', text: 'hello remote' }] },
      }),
      provider.request('hub/api/request', {
        endpointId: requestEndpointId, workspaceId: requestWorkspaceId,
        method: 'session.fork', payload: { sessionId: 'shared-session', atSeq: 3 },
      }),
      provider.request('hub/api/request', {
        endpointId: requestEndpointId, workspaceId: requestWorkspaceId,
        method: 'workspace.archiveSession', payload: { sessionId: 'shared-session' },
      }),
    ])
  console.log(JSON.stringify({
    type: 'ready',
    endpointId: provider.connectedServerInfo?.endpointId ?? null,
    serverInfo: provider.connectedServerInfo?.serverInfo ?? null,
    endpoints,
    workspaces,
    ...(request === undefined ? {} : { request }),
    ...(business === undefined ? {} : { business }),
    ...(subscribeHost ? { hostFrames } : {}),
    ...(subscribeEvents ? { eventFrames } : {}),
  }))
  disposeHost?.()
  disposeEvents?.()
} catch (error) {
  console.log(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}

process.stdin.resume()

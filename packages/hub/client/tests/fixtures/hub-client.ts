/** Two-process Hub Client fixture for the endpoint identity integration test. */

import { RemoteSessionProvider } from '../../src/remote-session-provider.ts'

const uri = process.argv[2]
if (uri === undefined) throw new Error('Hub Client fixture requires a WebSocket URI')

const provider = new RemoteSessionProvider({} as never, { uri })
try {
  await provider.connect()
  console.log(JSON.stringify({
    type: 'ready',
    endpointId: provider.connectedServerInfo?.endpointId ?? null,
    serverInfo: provider.connectedServerInfo?.serverInfo ?? null,
  }))
} catch (error) {
  console.log(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}

process.stdin.resume()

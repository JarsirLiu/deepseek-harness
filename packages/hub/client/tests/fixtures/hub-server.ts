/** Two-process Hub Server fixture for the endpoint identity integration test. */

import { HubServer } from '@deepseek-ai/dsh-hub-server'

const port = Number(process.argv[2])
const endpointId = (process.argv[3] ?? 'remote:process-endpoint') as `remote:${string}`

const ctx = {
  logger: {
    info: (_message: string) => {},
    warn: (_message: string) => {},
    error: (_message: string) => {},
  },
  on: (_event: string, _listener: (...args: never[]) => void) => () => {},
  get: (key: string): unknown => key === 'apiProxy'
    ? {
      events: {
        host: async function* () { await new Promise<void>(() => {}) },
        mux: async function* (_request: unknown, signal: AbortSignal) {
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        },
      },
    }
    : undefined,
}

const server = new HubServer(ctx as never, {
  port,
  host: '127.0.0.1',
  endpointId,
  agentTokens: {
    'remote:registered-agent': 'agent-secret',
    'remote:second-agent': 'agent-secret',
    'remote:multi-agent': 'agent-secret',
    'remote:business-agent': 'agent-secret',
    'remote:event-agent': 'agent-secret',
    'remote:reconnect-agent': 'agent-secret',
  },
})
server.start()
await server.waitUntilListening()
console.log(JSON.stringify({ type: 'ready', endpointId, port }))

process.on('SIGTERM', () => { void server.stop().finally(() => process.exit(0)) })
process.stdin.resume()

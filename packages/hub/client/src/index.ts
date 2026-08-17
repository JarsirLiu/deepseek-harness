/**
 * Remote session provider plugin for the DeepSeek Harness remote hub
 * architecture. Provides a remote session transport over WebSocket JSON-RPC.
 *
 * @module @deepseek-ai/dsh-hub-client
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { RemoteSessionProvider } from './remote-session-provider.ts'
export { RemoteSessionProvider, HubConnectionError } from './remote-session-provider.ts'
export { HubEndpointAgent } from './endpoint-agent.ts'
export type { HubEndpointAgentConfig } from './endpoint-agent.ts'
export type { RemoteHubConfig } from './remote-session-provider.ts'

export const name = 'hub-client'
export const inject = ['sessions', 'webServer']

/** Configuration for a remote hub connection. */
export interface HubClientConfig {
  /** WebSocket URI of the remote hub server, e.g. ws://192.168.1.100:8765/hub */
  uri: string
  /** Optional authentication token. */
  token?: string
  /** Auto-connect on plugin load. */
  autoConnect?: boolean
  /** Delay between failed automatic connection attempts, in milliseconds. */
  reconnectDelay?: number
}

/** Cordis schema for the hub client configuration. */
export const Config: Schema<HubClientConfig> = Schema.object({
  uri: Schema.string().required().description('WebSocket URI of the remote hub server'),
  token: Schema.string().default('').description('Optional authentication token'),
  autoConnect: Schema.boolean().default(true).description('Auto-connect on plugin load'),
  reconnectDelay: Schema.number().default(3000).description('Delay between failed connection attempts'),
})

/**
 * Apply the hub client plugin: create a remote session provider and register
 * it as a dedicated remoteSessionProvider service. It also registers Hub
 * status and RPC endpoints on the webServer service when available.
 * @param ctx - Cordis context.
 * @param config - Plugin configuration.
 */
export function apply(ctx: Context, config: HubClientConfig): void {
  const provider = new RemoteSessionProvider(ctx, {
    uri: config.uri,
    ...(config.token ? { token: config.token } : {}),
    ...(config.reconnectDelay === undefined ? {} : { reconnectDelay: config.reconnectDelay }),
  })
  // Keep remote transport separate from the process-wide local persistence.
  ctx.provide('remoteSessionProvider', provider)

  // Optionally register a hub status endpoint on the web server.
  const webServer = ctx.get('webServer') as
    | { register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => () => void }
    | undefined
  if (webServer !== undefined) {
    const rpcDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/rpc',
      handler: (req: unknown, res: unknown) => {
        const request = req as { on: (event: string, listener: (chunk: Buffer) => void) => void }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => { void (async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: string; params?: Record<string, unknown> }
            if (typeof body.method !== 'string') throw new Error('method is required')
            const result = await provider.request(body.method, body.params ?? {})
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify(result))
          } catch (error) {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        })() })
      },
    })
    ctx.effect(() => rpcDispose, 'hub-client.webServer.rpc')

    const dispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/status',
      handler: (_req: unknown, res: unknown) => {
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        const body = {
          endpointId: provider.connectedServerInfo?.endpointId ?? null,
          status: provider.connectionState,
          isConnected: provider.isConnected,
          uri: config.uri,
          serverInfo: provider.connectedServerInfo?.serverInfo ?? null,
        }
        response.end(JSON.stringify(body))
      },
    })
    ctx.effect(() => dispose, 'hub-client.webServer')
    const reconnectDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/reconnect',
      handler: (_req: unknown, res: unknown) => { void (async () => {
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        try {
          provider.disconnect()
          await provider.connect()
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ ok: true }))
        } catch (error) {
          response.writeHead(502, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })() },
    })
    ctx.effect(() => reconnectDispose, 'hub-client.webServer.reconnect')
    const configDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/client-config',
      handler: (_req: unknown, res: unknown) => {
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ uri: config.uri, token: config.token ?? '' }))
      },
    })
    ctx.effect(() => configDispose, 'hub-client.webServer.config')
    const sessionStreamDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/events.mux',
      handler: (req: unknown, res: unknown) => {
        const request = req as { url?: string }
        const response = res as {
          writeHead: (code: number, headers: Record<string, string>) => void
          write: (body: string) => void
          end: () => void
          on?: (event: string, listener: () => void) => void
        }
        const id = request.url === undefined
          ? undefined
          : new URL(request.url, 'http://localhost').searchParams.get('id')
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        response.write(': connected\n\n')
        const unsubscribe = id === null || id === undefined
          ? provider.onEvent((notification) => { response.write(`data: ${JSON.stringify(notification)}\n\n`) })
          : provider.subscribe(id as import('@deepseek-ai/dsh-session').SessionId, (notification) => {
            response.write(`data: ${JSON.stringify(notification)}\n\n`)
          })
        response.on?.('close', () => {
          unsubscribe()
          response.end()
        })
      },
    })
    ctx.effect(() => sessionStreamDispose, 'hub-client.webServer.session-stream')
    const hostStreamDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/host/stream',
      handler: (_req: unknown, res: unknown) => {
        const response = res as {
          writeHead: (code: number, headers: Record<string, string>) => void
          write: (body: string) => void
          end: () => void
          on?: (event: string, listener: () => void) => void
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        response.write(': connected\n\n')
        const unsubscribe = provider.onHostFrame((notification) => { response.write(`data: ${JSON.stringify(notification)}\n\n`) })
        response.on?.('close', () => { unsubscribe(); response.end() })
      },
    })
    ctx.effect(() => hostStreamDispose, 'hub-client.webServer.host-stream')
  }

  // Auto-connect if configured.
  if (config.autoConnect) {
    ctx.effect(() => {
      let disposed = false
      let retryTimer: ReturnType<typeof setTimeout> | undefined

      const connect = (): void => {
        if (disposed || provider.isConnected) return
        void provider.connect().catch((error: unknown) => {
          if (disposed) return
          ctx.logger.warn(`hub client: connection failed: ${error instanceof Error ? error.message : String(error)}`)
          retryTimer = setTimeout(connect, config.reconnectDelay ?? 3000)
        })
      }

      connect()
      return () => {
        disposed = true
        if (retryTimer !== undefined) clearTimeout(retryTimer)
        provider.disconnect()
      }
    }, 'hub-client')
  }
}

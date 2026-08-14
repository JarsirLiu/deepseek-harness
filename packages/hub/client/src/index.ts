/**
 * Remote session provider plugin for the DeepSeek Harness remote hub
 * architecture. Implements the SessionPersistence seam by forwarding all
 * operations to a remote hub server over WebSocket JSON-RPC.
 *
 * @module @deepseek-ai/dsh-hub-client
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { HubStatusResponse } from '@deepseek-ai/dsh-hub-protocol'
import { RemoteSessionProvider } from './remote-session-provider.ts'

export { RemoteSessionProvider, HubConnectionError } from './remote-session-provider.ts'
export type { RemoteHubConfig } from './remote-session-provider.ts'

export const name = 'hub-client'
export const inject = ['sessions']

/** Configuration for a remote hub connection. */
export interface HubClientConfig {
  /** WebSocket URI of the remote hub server, e.g. ws://192.168.1.100:8765/hub */
  uri: string
  /** Optional authentication token. */
  token?: string
  /** Auto-connect on plugin load. */
  autoConnect?: boolean
}

/** Cordis schema for the hub client configuration. */
export const Config: Schema<HubClientConfig> = Schema.object({
  uri: Schema.string().required().description('WebSocket URI of the remote hub server'),
  token: Schema.string().default('').description('Optional authentication token'),
  autoConnect: Schema.boolean().default(true).description('Auto-connect on plugin load'),
})

/**
 * Apply the hub client plugin: create a remote session provider and register
 * it as the sessionPersistence service. course additionally registers a hub
 * status endpoint on the webServer service when available.
 * @param ctx - Cordis context.
 * @param config - Plugin configuration.
 */
export function apply(ctx: Context, config: HubClientConfig): void {
  const provider = new RemoteSessionProvider(ctx, {
    uri: config.uri,
    ...(config.token ? { token: config.token } : {}),
  })

  // Register as the sessionPersistence service.
  ctx.provide('sessionPersistence', provider)

  // Optionally register a hub status endpoint on the web server.
  const webServer = ctx.get('webServer') as
    | { register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => () => void }
    | undefined
  if (webServer !== undefined) {
    const dispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/status',
      handler: (_req: unknown, res: unknown) => {
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        const body: HubStatusResponse = {
          status: provider.connectionState,
          isConnected: provider.isConnected,
          uri: config.uri,
          serverInfo: provider.connectedServerInfo?.serverInfo ?? null,
        }
        response.end(JSON.stringify(body))
      },
    })
    ctx.effect(() => dispose, 'hub-client.webServer')
  }

  // Auto-connect if configured.
  if (config.autoConnect) {
    ctx.effect(() => {
      provider.connect().catch((error: unknown) => {
        ctx.logger.warn(`hub client: connection failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return () => {
        provider.disconnect()
      }
    }, 'hub-client')
  }
}

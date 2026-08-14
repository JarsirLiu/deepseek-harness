/**
 * WebSocket JSON-RPC hub server plugin for the DeepSeek Harness remote hub
 * architecture. Mount this plugin on a harness instance to expose its sessions
 * to remote clients over WebSocket JSON-RPC.
 *
 * @module @deepseek-ai/dsh-hub-server
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { HubServer, type HubServerConfig } from './server.ts'

export { HubServer } from './server.ts'
export type { HubServerConfig } from './server.ts'

export const name = 'hub-server'
export const inject = ['sessions']

/** Cordis schema for the hub server configuration. */
export const Config: Schema<HubServerConfig> = Schema.object({
  port: Schema.number().default(8765).description('TCP port to listen on'),
  host: Schema.string().default('127.0.0.1').description('Host to bind to'),
  authTokens: Schema.array(Schema.string()).default([]).description('Optional authentication tokens'),
  serverName: Schema.string().default('deepseek-harness-hub').description('Server identity name'),
  workspacePresets: Schema.dict(Schema.string()).default({}).description('Remote agent preset by workspace id'),
})

/**
 * Apply the hub server plugin: start accepting WebSocket connections.
 * @param ctx - Cordis context.
 * @param config - Plugin configuration.
 */
export function apply(ctx: Context, config: HubServerConfig): void {
  const server = new HubServer(ctx, config)
  server.start()

  ctx.effect(() => {
    return async () => {
      await server.stop()
    }
  }, 'hub-server')
}

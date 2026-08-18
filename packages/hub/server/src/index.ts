/**
 * WebSocket JSON-RPC hub server plugin for the DeepSeek Harness remote hub
 * architecture. Mount this plugin on a harness instance to expose its sessions
 * to remote clients over WebSocket JSON-RPC.
 *
 * @module @deepseek-ai/dsh-hub-server
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { HubServerConfig } from './server.ts'
import { HubServerManager, HUB_SERVER_NS, type HubServerSettings } from './server-manager.ts'
import { createHubIdentity } from './identity.ts'

export { HubServer } from './server.ts'
export type { HubServerConfig } from './server.ts'
export { HubServerManager, HUB_SERVER_NS } from './server-manager.ts'
export { createHubIdentity } from './identity.ts'
export type { HubServerSettings, HubServerState } from './server-manager.ts'

export const name = 'hub-server'
export const inject = ['sessions', 'settings', 'credentials']

/** Cordis schema for the hub server configuration. */
export const Config: Schema<HubServerConfig> = Schema.object({
  endpointId: Schema.string().default('').description('Stable endpoint identity') as Schema<`remote:${string}`>,
  port: Schema.number().default(8765).description('TCP port to listen on'),
  host: Schema.string().default('127.0.0.1').description('Host to bind to'),
  authTokens: Schema.array(Schema.string()).default([]).description('Optional authentication tokens'),
  agentTokens: Schema.dict(Schema.string()).default({}).description('Endpoint identity to registration token'),
  serverName: Schema.string().default('deepseek-harness-hub').description('Server identity name'),
  workspacePresets: Schema.dict(Schema.string()).default({}).description('Remote agent preset by workspace id'),
})

/**
 * Apply the hub server plugin: start accepting WebSocket connections.
 * @param ctx - Cordis context.
 * @param config - Plugin configuration.
 */
export function apply(ctx: Context, config: HubServerConfig): void {
  const identity = createHubIdentity(config.serverName)
  const settings = ctx.settings.register(HUB_SERVER_NS, Schema.object({
    endpointId: Schema.string().default(config.endpointId || identity.endpointId) as Schema<`remote:${string}`>,
    serverName: Schema.string().default(config.serverName ?? 'deepseek-harness-hub'),
    host: Schema.string().default(config.host ?? '127.0.0.1'),
    port: Schema.number().default(config.port ?? 8765),
    credentialRef: Schema.string().default(identity.credentialRef),
    credentialEnabled: Schema.boolean().default(true),
    publicAddress: Schema.string().default(''),
    enabled: Schema.boolean().default(true),
  }) as Schema<HubServerSettings>)
  const manager = new HubServerManager(ctx, settings)
  ctx.provide('hubServerManager', manager)

  const webServer = ctx.get('webServer') as { register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => () => void } | undefined
  if (webServer !== undefined) {
    const dispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/server',
      handler: (req: unknown, res: unknown) => {
        const request = req as { method?: string; on: (event: string, listener: (chunk: Buffer) => void) => void }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        if (request.method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(manager.get()))
          return
        }
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => { void (async () => {
          try {
            const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
            const operation = body.operation
            let result: unknown
            if (operation === 'update') result = await manager.update(body.patch as Partial<HubServerSettings>)
            else if (operation === 'start') result = await manager.start()
            else if (operation === 'stop') result = await manager.stop()
            else if (operation === 'test') result = await manager.test()
            else if (operation === 'credential') result = await manager.connectionCredential()
            else if (operation === 'enable-credential') result = await manager.enableCredential()
            else if (operation === 'disable-credential') result = await manager.disableCredential()
            else if (operation === 'regenerate-credential') result = await manager.regenerateCredential()
            else throw new Error('unknown hub server operation')
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ result }))
          } catch (error) {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        })() })
      },
    })
    ctx.effect(() => dispose, 'hub-server.webServer')
  }

  ctx.effect(() => {
    return async () => { await manager.stop() }
  }, 'hub-server')
}

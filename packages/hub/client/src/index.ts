/**
 * Remote session provider plugin for the DeepSeek Harness remote hub
 * architecture. Provides a remote session transport over WebSocket JSON-RPC.
 *
 * @module @deepseek-ai/dsh-hub-client
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { HubStatusResponse } from '@deepseek-ai/dsh-hub-protocol'
import type { HubWorkspaceListResult } from '@deepseek-ai/dsh-hub-protocol'
import { RemoteAgentClient, RemoteSessionProvider } from './remote-session-provider.ts'

export { RemoteAgentClient, RemoteSessionProvider, HubConnectionError } from './remote-session-provider.ts'
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
}

/** Cordis schema for the hub client configuration. */
export const Config: Schema<HubClientConfig> = Schema.object({
  uri: Schema.string().required().description('WebSocket URI of the remote hub server'),
  token: Schema.string().default('').description('Optional authentication token'),
  autoConnect: Schema.boolean().default(true).description('Auto-connect on plugin load'),
})

/**
 * Apply the hub client plugin: create a remote session provider and register
 * it as a dedicated remoteSessionProvider service. It also registers Hub
 * status and forwarding endpoints on the webServer service when available.
 * @param ctx - Cordis context.
 * @param config - Plugin configuration.
 */
export function apply(ctx: Context, config: HubClientConfig): void {
  const provider = new RemoteSessionProvider(ctx, {
    uri: config.uri,
    ...(config.token ? { token: config.token } : {}),
  })
  const remoteAgent = new RemoteAgentClient(provider)
  ctx.provide('remoteAgent', remoteAgent)

  // Keep remote transport separate from the process-wide local persistence.
  ctx.provide('remoteSessionProvider', provider)

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
    const workspacesDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/workspaces',
      handler: (_req: unknown, res: unknown) => {
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        void provider.request('hub/workspaces', {}).then((result) => {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(result as HubWorkspaceListResult))
        }).catch((error) => {
          response.writeHead(502, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        })
      },
    })
    ctx.effect(() => workspacesDispose, 'hub-client.webServer.workspaces')
    const createWorkspaceSessionDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/workspace-session/create',
      handler: async (req: unknown, res: unknown) => {
        const request = req as { method?: string; url?: string }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        const workspaceId = request.url === undefined
          ? undefined
          : new URL(request.url, 'http://localhost').searchParams.get('workspaceId') ?? undefined
        if (request.method !== 'GET' || workspaceId === undefined) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'workspaceId is required' }))
          return
        }
        try {
          const result = await provider.request('hub/workspace-session/create', { workspaceId })
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(result))
        } catch (error) {
          response.writeHead(502, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    ctx.effect(() => createWorkspaceSessionDispose, 'hub-client.webServer.workspace-session-create')
    const sessionLoadDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/session/load',
      handler: async (req: unknown, res: unknown) => {
        const request = req as { url?: string }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        const id = request.url === undefined ? undefined : new URL(request.url, 'http://localhost').searchParams.get('id')
        if (id === null || id === undefined) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"id is required"}'); return }
        try {
          const result = await provider.request('hub/load', { id })
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
        } catch (error) {
          response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    ctx.effect(() => sessionLoadDispose, 'hub-client.webServer.session-load')
    const agentMessageDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/session/message',
      handler: async (req: unknown, res: unknown) => {
        const request = req as { url?: string }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        const params = request.url === undefined ? undefined : new URL(request.url, 'http://localhost').searchParams
        const id = params?.get('id'); const text = params?.get('text'); const mode = params?.get('mode') === 'steer' ? 'steer' : 'queue'
        if (id === null || id === undefined || text === null || text === undefined) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"id and text are required"}'); return }
        try {
          const result = await remoteAgent.sendText(id as import('@deepseek-ai/dsh-session').SessionId, text)
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ accepted: true, mode, result }))
        } catch (error) {
          response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    ctx.effect(() => agentMessageDispose, 'hub-client.webServer.session-message')
    const agentCancelDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/session/cancel',
      handler: async (req: unknown, res: unknown) => {
        const request = req as { url?: string }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        const id = request.url === undefined ? undefined : new URL(request.url, 'http://localhost').searchParams.get('id')
        if (id === null || id === undefined) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"id is required"}'); return }
        try {
          await provider.request('hub/agent/cancel', { id })
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"accepted":true}')
        } catch (error) {
          response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    ctx.effect(() => agentCancelDispose, 'hub-client.webServer.session-cancel')
    const sessionStreamDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/session/stream',
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
        if (id === null || id === undefined) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end()
          return
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        const unsubscribe = provider.subscribe(id as import('@deepseek-ai/dsh-session').SessionId, (notification) => {
          response.write(`data: ${JSON.stringify(notification)}\n\n`)
        })
        response.on?.('close', () => {
          unsubscribe()
          response.end()
        })
      },
    })
    ctx.effect(() => sessionStreamDispose, 'hub-client.webServer.session-stream')
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

/**
 * Remote session provider plugin for the DeepSeek Harness remote hub
 * architecture. Provides a remote session transport over WebSocket JSON-RPC.
 *
 * @module @deepseek-ai/dsh-hub-client
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { HubWorkspaceListResult } from '@deepseek-ai/dsh-hub-protocol'
import { RemoteAgentClient, RemoteSessionProvider } from './remote-session-provider.ts'

export { RemoteAgentClient, RemoteSessionProvider, HubConnectionError } from './remote-session-provider.ts'
export type { RemoteHubConfig } from './remote-session-provider.ts'

export const name = 'hub-client'
export const inject = ['sessions', 'webServer']

/** Configuration for a remote hub connection. */
export interface HubClientConfig {
  /** Stable endpoint identity used to qualify remote sessions. */
  endpointId?: `remote:${string}`
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
  endpointId: Schema.string().default('remote:configured-hub').description('Stable remote endpoint identity') as Schema<`remote:${string}`>,
  uri: Schema.string().required().description('WebSocket URI of the remote hub server'),
  token: Schema.string().default('').description('Optional authentication token'),
  autoConnect: Schema.boolean().default(true).description('Auto-connect on plugin load'),
  reconnectDelay: Schema.number().default(3000).description('Delay between failed connection attempts'),
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
    ...(config.reconnectDelay === undefined ? {} : { reconnectDelay: config.reconnectDelay }),
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
        const body = {
          endpointId: provider.connectedServerInfo?.endpointId ?? config.endpointId ?? 'remote:configured-hub',
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
      handler: async (_req: unknown, res: unknown) => {
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
      },
    })
    ctx.effect(() => reconnectDispose, 'hub-client.webServer.reconnect')
    const configDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/client-config',
      handler: (_req: unknown, res: unknown) => {
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ endpointId: config.endpointId ?? 'remote:configured-hub', uri: config.uri, token: config.token ?? '' }))
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
          const workspaces = result as HubWorkspaceListResult
          response.end(JSON.stringify({ ...workspaces, endpointId: provider.connectedServerInfo?.endpointId ?? workspaces.endpointId }))
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
    const sessionHistoryDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/session/history',
      handler: async (req: unknown, res: unknown) => {
        const request = req as { url?: string }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        const params = request.url === undefined ? undefined : new URL(request.url, 'http://localhost').searchParams
        const id = params?.get('id')
        if (id === null || id === undefined) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"id is required"}'); return }
        try {
          const result = await provider.request('hub/session/history', {
            id,
            ...(params?.get('beforeSeq') === null ? {} : { beforeSeq: Number(params?.get('beforeSeq')) }),
            ...(params?.get('maxMessages') === null ? {} : { maxMessages: Number(params?.get('maxMessages')) }),
          })
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
        } catch (error) {
          response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    ctx.effect(() => sessionHistoryDispose, 'hub-client.webServer.session-history')
    const sessionModelsDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/session/models',
      handler: async (req: unknown, res: unknown) => {
        const request = req as { url?: string }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        const id = request.url === undefined ? undefined : new URL(request.url, 'http://localhost').searchParams.get('id')
        if (id === null || id === undefined) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"id is required"}'); return }
        try {
          const result = await provider.request('hub/session/models', { id })
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
        } catch (error) {
          response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    ctx.effect(() => sessionModelsDispose, 'hub-client.webServer.session-models')
    const sessionSelectModelDispose = webServer.register({
      kind: 'exact',
      path: '/api/hub/session/select-model',
      handler: async (req: unknown, res: unknown) => {
        const request = req as { url?: string }
        const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
        const params = request.url === undefined ? undefined : new URL(request.url, 'http://localhost').searchParams
        const id = params?.get('id'); const providerName = params?.get('provider'); const model = params?.get('model'); const reasoningEffort = params?.get('reasoningEffort') ?? undefined
        if (id === null || id === undefined || providerName === null || model === null) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"id, provider and model are required"}'); return }
        try {
          const result = await provider.request('hub/session/select-model', { id, provider: providerName, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
          response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
        } catch (error) {
          response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    ctx.effect(() => sessionSelectModelDispose, 'hub-client.webServer.session-select-model')
    const sessionMutationRoutes = [
      ['/api/hub/session/rename', 'hub/session/rename'],
      ['/api/hub/session/update-queue', 'hub/session/update-queue'],
      ['/api/hub/session/attachment', 'hub/session/attachment'],
      ['/api/hub/session/fork', 'hub/session/fork'],
    ] as const
    for (const [path, method] of sessionMutationRoutes) {
      const dispose = webServer.register({
        kind: 'exact',
        path,
        handler: async (req: unknown, res: unknown) => {
          const request = req as { url?: string }
          const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
          const params = request.url === undefined ? undefined : new URL(request.url, 'http://localhost').searchParams
          const id = params?.get('id')
          if (id === null || id === undefined) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"id is required"}'); return }
          const payload = method === 'hub/session/rename'
            ? { id, title: params?.get('title') ?? '' }
            : method === 'hub/session/update-queue'
              ? { id, itemId: params?.get('itemId') ?? '', action: JSON.parse(params?.get('action') ?? 'null') }
              : method === 'hub/session/attachment'
                ? { id, attachmentId: params?.get('attachmentId') ?? '' }
                : { id, ...(params?.get('atSeq') === null ? {} : { atSeq: Number(params?.get('atSeq')) }) }
          try {
            const result = await provider.request(method, payload)
            response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
          } catch (error) {
            response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      })
      ctx.effect(() => dispose, `hub-client.webServer.${method}`)
    }
    const subagentRoutes = [
      ['/api/hub/subagent/list', 'hub/subagent/list'],
      ['/api/hub/subagent/history', 'hub/subagent/history'],
      ['/api/hub/subagent/prompt', 'hub/subagent/prompt'],
      ['/api/hub/subagent/interrupt', 'hub/subagent/interrupt'],
    ] as const
    for (const [path, method] of subagentRoutes) {
      const dispose = webServer.register({
        kind: 'exact', path,
        handler: async (req: unknown, res: unknown) => {
          const request = req as { url?: string }
          const response = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }
          const params = request.url === undefined ? undefined : new URL(request.url, 'http://localhost').searchParams
          const parentSessionId = params?.get('parentSessionId')
          const childSessionId = params?.get('childSessionId')
          const mode = params?.get('mode')
          if (parentSessionId === null || parentSessionId === undefined || (method !== 'hub/subagent/list' && (childSessionId === null || childSessionId === undefined || (mode !== 'one-shot' && mode !== 'continuable')))) {
            response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"error":"invalid subagent address"}'); return
          }
          const payload = method === 'hub/subagent/list'
            ? { parentSessionId }
            : { parentSessionId, childSessionId, mode, ...(method === 'hub/subagent/history' ? { beforeSeq: params?.get('beforeSeq') === null ? undefined : Number(params?.get('beforeSeq')), maxMessages: params?.get('maxMessages') === null ? undefined : Number(params?.get('maxMessages')) } : {}), ...(method === 'hub/subagent/prompt' ? { content: JSON.parse(params?.get('content') ?? '[]') } : {}) }
          try {
            const result = await provider.request(method, payload)
            response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
          } catch (error) {
            response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      })
      ctx.effect(() => dispose, `hub-client.webServer.${method}`)
    }
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
          const result = await remoteAgent.sendText(id as import('@deepseek-ai/dsh-session').SessionId, text, mode)
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

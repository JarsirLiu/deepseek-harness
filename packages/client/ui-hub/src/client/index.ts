/**
 * Remote hub settings section plugin, browser half: registers a Remote Hub
 * section into the settings panel. Shows connection status, server info, and
 * configuration for the remote hub connection.
 *
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { HubStatusResponse, HubWorkspaceListResult, HubWorkspaceRef } from '@deepseek-ai/dsh-hub-protocol'
import type { RpcResult, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createRemoteSessionTransport, REMOTE_SESSION_REGISTRY, REMOTE_WORKSPACE_SOURCE, RemoteSessionTransportRegistry, type RemoteWorkspace, type RemoteWorkspaceSource } from '@deepseek-ai/dsh-hub-web-adapter'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { HubSection, type HubStatusResult, type HubEndpointState, type HubServerState } from './HubSection.tsx'
import { en, zh, type HubLocaleKey } from './locales.ts'

export type { HubSectionProps } from './HubSection.tsx'
export type { HubLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Remote hub settings copy. */
    hub: HubLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'hub'

/** Required services: the slot registry, locale, and the settings slot types. */
export const inject = ['slots', 'locale', 'sessions']

/** Load the Hub status response through the host web endpoint. */
async function loadHubStatus(): Promise<HubStatusResult> {
  const response = await globalThis.fetch('/api/hub/status', { credentials: 'same-origin' })
  if (response.status === 404) {
    const server = await globalThis.fetch('/api/hub/server', { credentials: 'same-origin' })
    if (server.status === 404) return { kind: 'unavailable' }
    if (!server.ok) throw new Error(`HTTP ${server.status}`)
    const value = await server.json() as { host?: string; port?: number }
    return {
      kind: 'ready',
      status: {
        endpointId: null,
        status: 'disconnected',
        isConnected: false,
        uri: `ws://${value.host ?? '127.0.0.1'}:${value.port ?? 8765}/hub`,
        serverInfo: null,
      },
    }
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const status = await response.json() as HubStatusResponse
  // An installed client with no configured endpoint is a normal empty state.
  // Keep it distinct from a configured endpoint that failed to connect.
  if (status.uri === '' && status.endpointId === null) return { kind: 'unavailable' }
  return { kind: 'ready', status }
}

/**
 * Register the Remote Hub section into the settings panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-hub: dictionaries')

  const t = ctx.locale.bind(NS)
  let endpointId: `remote:${string}` | undefined
  const transportRegistry = new RemoteSessionTransportRegistry()
  let disposeTransport = (): void => {}

  const bindTransport = (): void => {
    disposeTransport()
    const connectedEndpointId = endpointId
    if (connectedEndpointId === undefined) return
    disposeTransport = transportRegistry.register(createRemoteSessionTransport(connectedEndpointId))
  }

  const remoteWorkspaceSource: RemoteWorkspaceSource = {
    listSelected: async () => {
      const selected = await globalThis.fetch('/api/hub/endpoints', { credentials: 'same-origin' }).then(response => response.json() as Promise<{ selectedWorkspaces?: HubWorkspaceRef[] }>).then(value => value.selectedWorkspaces ?? [])
      const result = await rpc<HubWorkspaceListResult>('hub/workspaces', { workspaces: selected })
      await rpc('hub/subscribe-workspaces', { workspaces: selected })
      const connectedEndpointId = result.endpointId
      const endpointChanged = endpointId !== connectedEndpointId
      endpointId = connectedEndpointId
      if (endpointChanged) bindTransport()
      return result.workspaces
        .map(workspace => ({
          endpointId: workspace.endpointId,
          workspaceId: workspace.id,
          title: workspace.title,
          path: workspace.path,
          sessions: workspace.sessions.map(session => ({
            endpointId: session.endpointId,
            sessionId: session.sessionId,
            updatedAt: session.updatedAt,
            running: session.running,
            blank: session.blank,
            ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
            ...(session.title === undefined ? {} : { title: session.title }),
            ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
            ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
            ...(session.origin === undefined ? {} : { origin: session.origin }),
          })),
        }))
    },
    createSession: async (workspace) => {
      const result = await rpc<RpcResult<{ sessionId: SessionId }>>('hub/api/request', {
        endpointId: workspace.endpointId, workspaceId: workspace.workspaceId,
        method: 'session.create', payload: { workspaceId: workspace.workspaceId },
      })
      if (!result.ok) throw new Error('remote session creation failed')
      return result.value.sessionId
    },
    rename: async (workspace, title) => {
      const result = await rpc<RpcResult<RemoteWorkspace>>('hub/api/request', {
        endpointId: workspace.endpointId, workspaceId: workspace.workspaceId,
        method: 'workspace.rename', payload: { workspaceId: workspace.workspaceId, title },
      })
      if (!result.ok) throw new Error('remote workspace rename failed')
      return { ...workspace, ...result.value }
    },
    delete: async (workspace) => {
      await rpc('hub/api/request', { endpointId: workspace.endpointId, workspaceId: workspace.workspaceId, method: 'workspace.delete', payload: { workspaceId: workspace.workspaceId } })
    },
    insertBefore: async (workspace, before) => {
      await rpc('hub/api/request', { endpointId: workspace.endpointId, workspaceId: workspace.workspaceId, method: 'workspace.insertBefore', payload: { workspaceId: workspace.workspaceId, ...(before === undefined ? {} : { beforeWorkspaceId: before.workspaceId }) } })
    },
    insertSessionBefore: async (workspace, sessionId, beforeSessionId) => {
      const result = await rpc<RpcResult<RemoteWorkspace>>('hub/api/request', { endpointId: workspace.endpointId, workspaceId: workspace.workspaceId, method: 'workspace.insertSessionBefore', payload: { workspaceId: workspace.workspaceId, sessionId, ...(beforeSessionId === undefined ? {} : { beforeSessionId }) } })
      if (!result.ok) throw new Error('remote session reorder failed')
      return { ...workspace, ...result.value }
    },
  }
  ctx.provide(REMOTE_SESSION_REGISTRY, transportRegistry)
  ctx.effect(() => {
    bindTransport()
    return () => { disposeTransport() }
  }, 'ui-hub: remote endpoint transport')
  ctx.provide(REMOTE_WORKSPACE_SOURCE, remoteWorkspaceSource)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hub',
    order: 80,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      loadStatus: loadHubStatus,
      reconnect: async () => {
        const response = await globalThis.fetch('/api/hub/reconnect', { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      },
      listEndpoints: async (): Promise<HubEndpointState[]> => {
        const response = await globalThis.fetch('/api/hub/endpoints', { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json() as { endpoints: HubEndpointState[] }).endpoints
      },
      endpointOperation: async (operation: string, body: Record<string, unknown>): Promise<unknown> => {
        const response = await globalThis.fetch('/api/hub/endpoints', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation, ...body }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as unknown
      },
      loadServer: async (): Promise<HubServerState | undefined> => {
        const response = await globalThis.fetch('/api/hub/server', { credentials: 'same-origin' })
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as HubServerState
      },
      serverOperation: async (operation: string, body: Record<string, unknown> = {}): Promise<unknown> => {
        const response = await globalThis.fetch('/api/hub/server', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, ...body }) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json() as unknown
      },
      loadSelectedWorkspaces: async (): Promise<HubWorkspaceRef[]> => {
        const response = await globalThis.fetch('/api/hub/endpoints', { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json() as { selectedWorkspaces?: HubWorkspaceRef[] }).selectedWorkspaces ?? []
      },
      saveSelectedWorkspaces: async (workspaces: HubWorkspaceRef[]): Promise<void> => {
        const response = await globalThis.fetch('/api/hub/endpoints', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'set-selected-workspaces', workspaces }) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      },
      loadWorkspaces: async () => {
        const selected = await globalThis.fetch('/api/hub/endpoints', { credentials: 'same-origin' }).then(response => response.json() as Promise<{ selectedWorkspaces?: HubWorkspaceRef[] }>).then(value => value.selectedWorkspaces ?? [])
        return await rpc<HubWorkspaceListResult>('hub/workspaces', { workspaces: selected })
      },
    }),
  }, HubSection))
}

async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const response = await globalThis.fetch('/api/hub/rpc', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as T
}

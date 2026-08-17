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
import { HubSection, type HubStatusResult } from './HubSection.tsx'
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
  if (response.status === 404) return { kind: 'unavailable' }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const status = await response.json() as HubStatusResponse
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
      const selected = readSelectedWorkspaceRefs()
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
      loadWorkspaces: async () => {
        return await rpc<HubWorkspaceListResult>('hub/workspaces', {})
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

function readSelectedWorkspaceRefs(): HubWorkspaceRef[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage.getItem('dsh.remote.selected-workspaces') ?? '[]')
    return Array.isArray(value) && value.every(item => isWorkspaceRef(item)) ? value : []
  } catch {
    return []
  }
}

function isWorkspaceRef(value: unknown): value is HubWorkspaceRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).endpointId === 'string'
    && typeof (value as Record<string, unknown>).workspaceId === 'string'
}

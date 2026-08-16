/**
 * Remote hub settings section plugin, browser half: registers a Remote Hub
 * section into the settings panel. Shows connection status, server info, and
 * configuration for the remote hub connection.
 *
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { HubStatusResponse, HubWorkspaceListResult } from '@deepseek-ai/dsh-hub-protocol'
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
  let endpointId = 'remote:configured-hub' as `remote:${string}`
  const transportRegistry = new RemoteSessionTransportRegistry()
  let disposeTransport = (): void => {}

  const bindTransport = (): void => {
    disposeTransport()
    disposeTransport = transportRegistry.register(createRemoteSessionTransport(() => endpointId))
  }

  const remoteWorkspaceSource: RemoteWorkspaceSource = {
    listSelected: async () => {
      const result = await rpc<HubWorkspaceListResult>('hub/workspaces', {})
      const selected = readSelectedWorkspaceIds()
      const endpointChanged = endpointId !== result.endpointId
      endpointId = result.endpointId
      if (endpointChanged) bindTransport()
      return result.workspaces
        .filter(workspace => selected.includes(workspace.id))
        .map(workspace => ({
          endpointId,
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
      const result = await rpc<{ sessionId: string }>('hub/workspace-session/create', { workspaceId: workspace.workspaceId })
      return result.sessionId as never
    },
    rename: async (workspace, title) => {
      const result = await rpc<RemoteWorkspace>('hub/workspace/rename', { workspaceId: workspace.workspaceId, title })
      return { ...workspace, ...result }
    },
    delete: async (workspace) => {
      await rpc('hub/workspace/delete', { workspaceId: workspace.workspaceId })
    },
    insertBefore: async (workspace, before) => {
      await rpc('hub/workspace/insert-before', { workspaceId: workspace.workspaceId, ...(before === undefined ? {} : { beforeWorkspaceId: before.workspaceId }) })
    },
    insertSessionBefore: async (workspace, sessionId, beforeSessionId) => {
      const result = await rpc<RemoteWorkspace>('hub/workspace/insert-session-before', { workspaceId: workspace.workspaceId, sessionId, ...(beforeSessionId === undefined ? {} : { beforeSessionId }) })
      return { ...workspace, ...result }
    },
  }
  ctx.provide(REMOTE_SESSION_REGISTRY, transportRegistry)
  ctx.effect(() => {
    bindTransport()
    return () => disposeTransport()
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

function readSelectedWorkspaceIds(): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage.getItem('dsh.remote.selected-workspaces') ?? '[]')
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []
  } catch {
    return []
  }
}

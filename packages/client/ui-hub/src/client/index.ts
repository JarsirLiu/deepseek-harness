/**
 * Remote hub settings section plugin, browser half: registers a Remote Hub
 * section into the settings panel. Shows connection status, server info, and
 * configuration for the remote hub connection.
 *
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HistoryEntry, MuxFrame, PromptContentPart, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'

const REMOTE_SESSION_ROUTER = 'remoteSessionRouter'

interface RemoteSessionRouter {
  owns(sessionId: SessionId): boolean
  history(
    sessionId: SessionId,
    payload: { beforeSeq?: number; maxMessages?: number },
  ): Promise<RpcResult<{ events: HistoryEntry[]; hasMore: boolean }>>
  prompt(sessionId: SessionId, content: PromptContentPart[], mode: 'queue' | 'steer'): Promise<RpcResult<{ accepted: true }>>
  cancel(sessionId: SessionId): Promise<RpcResult<{ accepted: true }>>
  subscribe(sessionId: SessionId, listener: (frame: MuxFrame) => void): () => void
}
import type { HubStatusResponse, HubWorkspaceListResult, HubWorkspaceSession } from '@deepseek-ai/dsh-hub-protocol'
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

  const remoteSessionIds = new Set<string>()
  const router: RemoteSessionRouter = {
    owns: sessionId => remoteSessionIds.has(String(sessionId)),
    history: async (sessionId, _payload) => {
      const response = await globalThis.fetch(`/api/hub/session/load?id=${encodeURIComponent(String(sessionId))}`, { credentials: 'same-origin' })
      if (!response.ok) return { ok: false, error: { code: 'internal', message: `HTTP ${response.status}`, details: {} } } as RpcResult<{ events: HistoryEntry[]; hasMore: boolean }>
      const loaded = await response.json() as { events: HistoryEntry['event'][] }
      return { ok: true, value: { events: loaded.events.map(event => ({ event })), hasMore: false } }
    },
    prompt: async (sessionId, content, mode) => {
      const text = content.filter((part): part is Extract<PromptContentPart, { type: 'text' }> => part.type === 'text').map(part => part.text).join('\n')
      const query = new URLSearchParams({ id: String(sessionId), text, mode })
      const response = await globalThis.fetch(`/api/hub/session/message?${query}`, { credentials: 'same-origin' })
      if (!response.ok) return { ok: false, error: { code: 'internal', message: `HTTP ${response.status}`, details: {} } } as RpcResult<{ accepted: true }>
      return { ok: true, value: { accepted: true } }
    },
    cancel: async (sessionId) => {
      const response = await globalThis.fetch(`/api/hub/session/cancel?id=${encodeURIComponent(String(sessionId))}`, { credentials: 'same-origin' })
      if (!response.ok) return { ok: false, error: { code: 'internal', message: `HTTP ${response.status}`, details: {} } } as RpcResult<{ accepted: true }>
      return { ok: true, value: { accepted: true } }
    },
    subscribe: (sessionId, listener) => {
      const source = new EventSource(`/api/hub/session/stream?id=${encodeURIComponent(String(sessionId))}`)
      source.onmessage = (event) => {
        const notification = JSON.parse(event.data) as { event: Record<string, unknown> }
        listener({ type: 'session/event', sessionId, event: notification.event as never } as MuxFrame)
      }
      return () => { source.close() }
    },
  }
  ctx.provide(REMOTE_SESSION_ROUTER, router)
  ctx.effect(() => {
    const onKnown = (event: Event): void => {
      const detail = (event as CustomEvent<HubWorkspaceSession>).detail
      remoteSessionIds.add(String(detail.sessionId))
      ;(ctx.sessions as unknown as {
        adoptRemote: (summary: HubWorkspaceSession) => void
      }).adoptRemote(detail)
    }
    const onCreated = (event: Event): void => {
      const detail = (event as CustomEvent<{ sessionId: SessionId }>).detail
      remoteSessionIds.add(String(detail.sessionId))
    }
    globalThis.addEventListener('dsh:remote-workspace-session-known', onKnown)
    globalThis.addEventListener('dsh:remote-workspace-session-created', onCreated)
    return () => {
      globalThis.removeEventListener('dsh:remote-workspace-session-known', onKnown)
      globalThis.removeEventListener('dsh:remote-workspace-session-created', onCreated)
    }
  }, 'ui-hub: remote session adoption')

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
        const response = await globalThis.fetch('/api/hub/workspaces', { credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const result = await response.json() as HubWorkspaceListResult
        for (const workspace of result.workspaces) {
          for (const session of workspace.sessions) {
            remoteSessionIds.add(String(session.sessionId))
            ;(ctx.sessions as unknown as {
              adoptRemote: (summary: HubWorkspaceSession) => void
            }).adoptRemote(session)
          }
        }
        return result
      },
    }),
  }, HubSection))
}

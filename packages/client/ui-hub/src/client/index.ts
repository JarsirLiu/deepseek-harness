/**
 * Remote hub settings section plugin, browser half: registers a Remote Hub
 * section into the settings panel. Shows connection status, server info, and
 * configuration for the remote hub connection.
 *
 * Export discipline: packages/client/AGENTS.md.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { HubStatusResponse } from '@deepseek-ai/dsh-hub-protocol'
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
export const inject = ['slots', 'locale']

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

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'hub',
    order: 80,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ loadStatus: loadHubStatus }),
  }, HubSection))
}

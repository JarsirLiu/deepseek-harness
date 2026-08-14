/**
 * Remote Hub settings section: shows connection status, server info, and
 * configuration for the remote hub connection. Fetches hub state from the
 * host-side hub-client plugin's `/api/hub/status` endpoint.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HubStatusResponse } from '@deepseek-ai/dsh-hub-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubLocaleKey } from './locales.ts'
import css from './HubSection.module.css'

/** Result of loading the host-side hub status endpoint. */
export type HubStatusResult =
  | { readonly kind: 'ready'; readonly status: HubStatusResponse }
  | { readonly kind: 'unavailable' }

/** Business face supplied by the plugin registration. */
export interface HubSectionInjected {
  /** Load the current Hub status from the host. */
  loadStatus: () => Promise<HubStatusResult>
}

/** View state for the section. */
type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | HubStatusResult

/** Full component props assembled by the Settings slot renderer. */
export type HubSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'hub'> & InjectFace<HubSectionInjected>

/** Status label key by connection state. */
const STATUS_LABEL = {
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'disconnected',
  error: 'error',
} satisfies Record<HubStatusResponse['status'], HubLocaleKey>

/** CSS classes for each complete connection state. */
const STATUS_DOT_CLASS: Record<HubStatusResponse['status'], string> = {
  connected: `${css.dot as string} ${css.connected as string}`,
  connecting: `${css.dot as string} ${css.connecting as string}`,
  disconnected: `${css.dot as string} ${css.disconnected as string}`,
  error: `${css.dot as string} ${css.error as string}`,
}

/**
 * Render the remote hub settings section.
 * @param props - section owner props and localized copy.
 * @returns the section element tree.
 */
export function HubSection({ t, loadStatus }: HubSectionProps): ReactNode {
  const [state, setState] = useState<ViewState>({ kind: 'loading' })

  const fetchStatus = useCallback((): void => {
    setState({ kind: 'loading' })
    loadStatus()
      .then((result) => { setState(result) })
      .catch((error: unknown) => {
        if (!(error instanceof Error)) throw error
        setState({ kind: 'error', message: error.message })
      })
  }, [loadStatus])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const statusDotClass = (): string => {
    if (state.kind !== 'ready') return css.dot as string
    return STATUS_DOT_CLASS[state.status.status]
  }

  // Loading state.
  if (state.kind === 'loading') {
    return (
      <div className={css.section}>
        <p className={css.status}>{t('status')}…</p>
      </div>
    )
  }

  // Unavailable: no hub-client installed.
  if (state.kind === 'unavailable') {
    return (
      <div className={css.section}>
        <h3 className={css.heading}>{t('title')}</h3>
        <div className={css.card}>
          <p className={css.emptyText}>{t('notConfigured')}</p>
          <p className={css.emptyHint}>{t('notConfiguredHint')}</p>
        </div>
      </div>
    )
  }

  // Fetch error state.
  if (state.kind === 'error') {
    return (
      <div className={css.section}>
        <h3 className={css.heading}>{t('title')}</h3>
        <div className={css.card}>
          <div className={css.row}>
            <span className={statusDotClass()} />
            <span className={css.errorText}>{t('error')}</span>
          </div>
          <p className={css.errorDetail}>{state.message}</p>
          <Button variant="outline" size="sm" onClick={fetchStatus}>{t('retry')}</Button>
        </div>
      </div>
    )
  }

  // Ready state.
  const status = state.status
  return (
    <div className={css.section}>
      <h3 className={css.heading}>{t('title')}</h3>
      <div className={css.card}>
        {/* Connection status */}
        <div className={css.row}>
          <span className={statusDotClass()} />
          <span className={css.label}>{t('status')}</span>
          <span className={css.value} data-status={status.status}>
            {t(STATUS_LABEL[status.status])}
          </span>
        </div>

        {/* Server URI */}
        <div className={css.row}>
          <span className={css.label}>{t('uri')}</span>
          <code className={css.mono}>{status.uri}</code>
        </div>

        {/* Server info (only when connected) */}
        {status.serverInfo !== null && (
          <>
            <div className={css.row}>
              <span className={css.label}>{t('serverName')}</span>
              <span className={css.value}>{status.serverInfo.name}</span>
            </div>
            <div className={css.row}>
              <span className={css.label}>{t('serverVersion')}</span>
              <span className={css.value}>{status.serverInfo.version}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

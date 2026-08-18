/**
 * Remote Hub settings section: shows connection status, server info, and
 * configuration for the remote hub connection. Fetches hub state from the
 * host-side hub-client plugin's `/api/hub/status` endpoint.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HubStatusResponse, HubWorkspaceEntry, HubWorkspaceListResult, HubWorkspaceRef } from '@deepseek-ai/dsh-hub-protocol'
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
  /** Load directories registered by the remote device. */
  loadWorkspaces: () => Promise<HubWorkspaceListResult>
  /** Reconnect the host Hub client and wait for the connection attempt. */
  reconnect: () => Promise<void>
  /** List configured Hub endpoints without exposing credentials. */
  listEndpoints: () => Promise<HubEndpointState[]>
  /** Apply one endpoint management operation through the Host. */
  endpointOperation: (operation: string, body: Record<string, unknown>) => Promise<void>
}

/** Redacted endpoint state returned by the Host connection manager. */
export interface HubEndpointState {
  id: string
  label: string
  uri: string
  credentialRef?: string
  enabled: boolean
  status: string
  endpointId?: string
  error?: string
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
export function HubSection({ t, loadStatus, loadWorkspaces, reconnect, listEndpoints, endpointOperation }: HubSectionProps): ReactNode {
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const [workspaces, setWorkspaces] = useState<HubWorkspaceEntry[]>([])
  const [selectedRefs, setSelectedRefs] = useState<HubWorkspaceRef[]>(() => readSelectedWorkspaceRefs())
  const [workspacesVersion, setWorkspacesVersion] = useState(0)
  const [endpoints, setEndpoints] = useState<HubEndpointState[]>([])
  const [newEndpoint, setNewEndpoint] = useState({ id: '', label: '', uri: '', credentialRef: '' })

  const refreshEndpoints = useCallback(() => {
    void listEndpoints().then(setEndpoints).catch(() => setEndpoints([]))
  }, [listEndpoints])

  useEffect(() => { refreshEndpoints() }, [refreshEndpoints])

  const addEndpoint = (): void => {
    if (!newEndpoint.id || !newEndpoint.uri) return
    void endpointOperation('create', { config: { ...newEndpoint, label: newEndpoint.label || newEndpoint.id, enabled: true } }).then(() => {
      setNewEndpoint({ id: '', label: '', uri: '', credentialRef: '' })
      refreshEndpoints()
    })
  }

  const toggleWorkspace = (workspace: HubWorkspaceEntry): void => {
    const ref = { endpointId: workspace.endpointId, workspaceId: workspace.id } satisfies HubWorkspaceRef
    const selected = selectedRefs.some(item => item.endpointId === ref.endpointId && item.workspaceId === ref.workspaceId)
    const next = selected
      ? selectedRefs.filter(item => item.endpointId !== ref.endpointId || item.workspaceId !== ref.workspaceId)
      : [...selectedRefs, ref]
    setSelectedRefs(next)
    globalThis.localStorage.setItem(SELECTED_WORKSPACES_KEY, JSON.stringify(next))
    globalThis.dispatchEvent(new CustomEvent('dsh:remote-workspaces-changed'))
  }

  const fetchStatus = useCallback((): void => {
    setState({ kind: 'loading' })
    setWorkspacesVersion(version => version + 1)
    reconnect()
      .catch(() => undefined)
      .then(() => loadStatus())
      .then((result) => { setState(result) })
      .catch((error: unknown) => {
        if (!(error instanceof Error)) throw error
        setState({ kind: 'error', message: error.message })
      })
  }, [loadStatus, reconnect])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    if (state.kind !== 'ready' || state.status.status !== 'connected') return
    loadWorkspaces().then((result) => {
      setWorkspaces(result.workspaces)
      globalThis.dispatchEvent(new CustomEvent('dsh:remote-workspaces-changed'))
    }).catch(() => { setWorkspaces([]) })
  }, [loadWorkspaces, state, workspacesVersion])

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
        <div className={css.workspaceList}>
          <span className={css.label}>Hub 节点</span>
          {endpoints.map(endpoint => (
            <div className={css.row} key={endpoint.id}>
              <span className={css.label}>{endpoint.label}</span>
              <code className={css.mono}>{endpoint.uri}</code>
              <span className={css.value}>{endpoint.status}</span>
              <Button variant="outline" size="sm" onClick={() => { void endpointOperation(endpoint.enabled ? 'disconnect' : 'connect', { id: endpoint.id }).then(refreshEndpoints) }}>
                {endpoint.enabled ? '断开' : '连接'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { void endpointOperation('delete', { id: endpoint.id }).then(refreshEndpoints) }}>删除</Button>
            </div>
          ))}
          <div className={css.row}>
            <input aria-label="Hub 节点 ID" value={newEndpoint.id} placeholder="节点 ID" onChange={(event) => { setNewEndpoint({ ...newEndpoint, id: event.target.value }) }} />
            <input aria-label="Hub 节点名称" value={newEndpoint.label} placeholder="名称" onChange={(event) => { setNewEndpoint({ ...newEndpoint, label: event.target.value }) }} />
            <input aria-label="Hub 地址" value={newEndpoint.uri} placeholder="ws://host:8765/hub" onChange={(event) => { setNewEndpoint({ ...newEndpoint, uri: event.target.value }) }} />
            <input aria-label="凭据引用" value={newEndpoint.credentialRef} placeholder="凭据引用" onChange={(event) => { setNewEndpoint({ ...newEndpoint, credentialRef: event.target.value }) }} />
            <Button variant="outline" size="sm" onClick={addEndpoint}>添加</Button>
          </div>
        </div>
        {/* Connection status */}
        <div className={css.row}>
          <span className={statusDotClass()} />
          <span className={css.label}>{t('status')}</span>
          <span className={css.value} data-status={status.status}>
            {t(STATUS_LABEL[status.status])}
          </span>
          <Button variant="outline" size="sm" onClick={fetchStatus}>{t('retry')}</Button>
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
        <div className={css.workspaceList}>
          <span className={css.label}>{t('workspaces')}</span>
          {workspaces.length === 0
            ? <span className={css.emptyText}>{t('noWorkspaces')}</span>
            : workspaces.map(workspace => (
              <label className={css.workspaceItem} key={`${workspace.endpointId}|${workspace.id}`}>
                <input
                  type="checkbox"
                  checked={selectedRefs.some(item => item.endpointId === workspace.endpointId && item.workspaceId === workspace.id)}
                  onChange={() => { toggleWorkspace(workspace) }}
                />
                <span>
                  <strong>{workspace.title}</strong>
                  <code className={css.mono}>{workspace.path}</code>
                </span>
              </label>
            ))}
        </div>
      </div>
    </div>
  )
}

const SELECTED_WORKSPACES_KEY = 'dsh.remote.selected-workspaces'

function readSelectedWorkspaceRefs(): HubWorkspaceRef[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage.getItem(SELECTED_WORKSPACES_KEY) ?? '[]')
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

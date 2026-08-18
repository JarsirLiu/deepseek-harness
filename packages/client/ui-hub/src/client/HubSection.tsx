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
  endpointOperation: (operation: string, body: Record<string, unknown>) => Promise<unknown>
  /** Load the local Hub listener state. */
  loadServer: () => Promise<HubServerState | undefined>
  /** Apply a local Hub listener operation. */
  serverOperation: (operation: string, body?: Record<string, unknown>) => Promise<unknown>
  /** Load endpoint-qualified workspace selections from Host settings. */
  loadSelectedWorkspaces: () => Promise<HubWorkspaceRef[]>
  /** Persist endpoint-qualified workspace selections in Host settings. */
  saveSelectedWorkspaces: (workspaces: HubWorkspaceRef[]) => Promise<void>
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

/** Redacted local Hub listener state. */
export interface HubServerState {
  endpointId: string
  serverName: string
  host: string
  port: number
  credentialRef: string
  credentialEnabled?: boolean
  enabled: boolean
  status: string
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
export function HubSection({
  t, loadStatus, loadWorkspaces, reconnect, listEndpoints, endpointOperation,
  loadServer, serverOperation, loadSelectedWorkspaces, saveSelectedWorkspaces,
}: HubSectionProps): ReactNode {
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const [workspaces, setWorkspaces] = useState<HubWorkspaceEntry[]>([])
  const [selectedRefs, setSelectedRefs] = useState<HubWorkspaceRef[]>([])
  const [workspacesVersion, setWorkspacesVersion] = useState(0)
  const [endpoints, setEndpoints] = useState<HubEndpointState[]>([])
  const [endpointsLoaded, setEndpointsLoaded] = useState(false)
  const [connectionCredential, setConnectionCredential] = useState('')
  const [generatedCredential, setGeneratedCredential] = useState('')
  const [server, setServer] = useState<HubServerState>()
  const [serverPatch, setServerPatch] = useState({ serverName: '' })

  const loadCredential = useCallback(async (): Promise<void> => {
    const result = await serverOperation('credential') as { result?: string }
    if (typeof result.result === 'string') setGeneratedCredential(result.result)
  }, [serverOperation])

  const refreshEndpoints = useCallback(() => {
    void listEndpoints()
      .then((value) => { setEndpoints(value); setEndpointsLoaded(true) })
      .catch(() => { setEndpoints([]); setEndpointsLoaded(true) })
  }, [listEndpoints])

  useEffect(() => { refreshEndpoints() }, [refreshEndpoints])
  useEffect(() => { void loadSelectedWorkspaces().then(setSelectedRefs).catch(() => setSelectedRefs([])) }, [loadSelectedWorkspaces])
  useEffect(() => { void loadServer().then((value) => {
    if (value !== undefined) {
      setServer(value)
      setServerPatch({ serverName: value.serverName })
      void loadCredential().catch(() => undefined)
    }
  }) }, [loadCredential, loadServer])

  const addEndpoint = (): void => {
    if (!connectionCredential.trim()) return
    void endpointOperation('import-credential', { credential: connectionCredential }).then(() => {
      setConnectionCredential('')
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
    void saveSelectedWorkspaces(next)
    globalThis.dispatchEvent(new CustomEvent('dsh:remote-workspaces-changed'))
  }

  const fetchStatus = useCallback((): void => {
    if (!endpointsLoaded) return
    if (endpoints.length === 0) {
      setState({ kind: 'unavailable' })
      return
    }
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
  }, [endpoints.length, endpointsLoaded, loadStatus, reconnect])

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

  const serverPanel = server === undefined ? null : (
    <section className={css.panel} aria-labelledby="hub-server-heading">
      <div className={css.panelHeader}>
        <div>
          <h4 id="hub-server-heading" className={css.panelTitle}>本机 Hub 服务</h4>
          <p className={css.panelHint}>让其他端点通过凭据连接到本机。</p>
        </div>
        <span className={`${css.badge} ${server.status === 'running' ? css.badgeSuccess : css.badgeMuted}`}>{server.status === 'running' ? '运行中' : server.status}</span>
      </div>
      <div className={css.serverMeta}>
        <code className={css.mono}>{server.host}:{server.port}</code>
        <Button variant="outline" size="sm" onClick={() => { void serverOperation(server.status === 'running' ? 'stop' : 'start').then(() => loadServer().then((value) => { if (value !== undefined) setServer(value) })) }}>{server.status === 'running' ? '停止服务' : '启动服务'}</Button>
        <Button variant="outline" size="sm" onClick={() => { void serverOperation('test') }}>测试连接</Button>
      </div>
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>服务名称</span>
          <input className={css.input} aria-label="本机 Hub 名称" value={serverPatch.serverName} placeholder="输入服务名称" onChange={event => setServerPatch({ serverName: event.target.value })} />
        </label>
        <Button variant="outline" size="sm" onClick={() => { void serverOperation('update', { patch: { serverName: serverPatch.serverName } }).then(() => loadServer().then((value) => { if (value !== undefined) setServer(value) })) }}>保存</Button>
      </div>
      <div className={css.credentialRow}>
        <div className={css.field}>
          <span className={css.fieldLabel}>连接凭据</span>
          {generatedCredential
            ? <input className={`${css.input} ${css.credentialInput} ${css.mono}`} aria-label="本机 Hub 连接凭据" value={generatedCredential} readOnly />
            : <span className={css.fieldHint}>生成后复制给需要连接本机的端点。</span>}
        </div>
        {generatedCredential && <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(generatedCredential) }}>复制</Button>}
        <Button variant="outline" size="sm" onClick={() => { void loadCredential() }}>生成凭据</Button>
        <Button variant="outline" size="sm" onClick={() => { void serverOperation(server.credentialEnabled === false ? 'enable-credential' : 'disable-credential').then(() => loadServer().then((value) => { if (value !== undefined) setServer(value) })) }}>{server.credentialEnabled === false ? '启用凭据' : '禁用凭据'}</Button>
      </div>
    </section>
  )

  const remotePanel = (
    <section className={css.panel} aria-labelledby="hub-client-heading">
      <div className={css.panelHeader}>
        <div>
          <h4 id="hub-client-heading" className={css.panelTitle}>连接远程 Hub</h4>
          <p className={css.panelHint}>粘贴远程端点生成的凭据，连接后再选择要显示的项目。</p>
        </div>
      </div>
      {state.kind === 'unavailable' && <><p className={css.emptyText}>{t('notConfigured')}</p><p className={css.emptyHint}>{t('notConfiguredHint')}</p></>}
      <div className={css.formRow}>
        <label className={css.field}>
          <span className={css.fieldLabel}>Hub 连接凭据</span>
          <input className={css.input} aria-label="Hub 连接凭据" value={connectionCredential} placeholder="粘贴 dshhub:v1:..." onChange={(event) => { setConnectionCredential(event.target.value) }} />
        </label>
        <Button variant="outline" size="sm" onClick={addEndpoint} disabled={!connectionCredential.trim()}>连接</Button>
      </div>
      {endpoints.length > 0 && <div className={css.endpointList}>
        {endpoints.map(endpoint => (
          <div className={css.endpoint} key={endpoint.id}>
            <div className={css.endpointMain}>
              <span className={css.endpointName}>{endpoint.label}</span>
              <code className={css.mono}>{endpoint.uri}</code>
            </div>
            <span className={`${css.badge} ${endpoint.status === 'connected' ? css.badgeSuccess : css.badgeMuted}`}>{endpoint.status}</span>
            <Button variant="outline" size="sm" onClick={() => { void endpointOperation(endpoint.enabled ? 'disconnect' : 'connect', { id: endpoint.id }).then(refreshEndpoints) }}>{endpoint.enabled ? '断开' : '连接'}</Button>
            <Button variant="outline" size="sm" onClick={() => { void endpointOperation('delete', { id: endpoint.id }).then(refreshEndpoints) }}>删除</Button>
          </div>
        ))}
      </div>}
    </section>
  )

  // Unavailable: both plugins are loaded; no remote endpoint has been added yet.
  if (state.kind === 'unavailable') {
    return (
      <div className={css.section}>
        <h3 className={css.heading}>{t('title')}</h3>
        {serverPanel}
        {remotePanel}
      </div>
    )
  }

  // Fetch error state.
  if (state.kind === 'error') {
    return (
      <div className={css.section}>
        <h3 className={css.heading}>{t('title')}</h3>
        {serverPanel}
        <section className={css.panel}><div className={css.row}><span className={statusDotClass()} /><span className={css.errorText}>{t('error')}</span></div><p className={css.errorDetail}>{state.message}</p><Button variant="outline" size="sm" onClick={fetchStatus}>{t('retry')}</Button></section>
      </div>
    )
  }

  // Ready state.
  const status = state.status
  return (
    <div className={css.section}>
      <h3 className={css.heading}>{t('title')}</h3>
      {serverPanel}
      {remotePanel}
      <div className={css.card}>
        {/* Connection status */}
        <div className={css.row}>
          <span className={statusDotClass()} />
          <span className={css.label}>{t('status')}</span>
          <span className={css.value} data-status={status.status}>
            {t(STATUS_LABEL[status.status])}
          </span>
          <Button variant="outline" size="sm" onClick={fetchStatus}>{t('retry')}</Button>
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

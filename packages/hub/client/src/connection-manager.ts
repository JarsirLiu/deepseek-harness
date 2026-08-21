import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { RemoteSessionProvider, type RemoteHubConfig } from './remote-session-provider.ts'
import { HubEndpointAgent } from './endpoint-agent.ts'
import { HubWorkspaceDirectoryProvider } from './workspace-directory.ts'
import type { HubWorkspaceRef } from '@deepseek-ai/dsh-hub-protocol'
import { randomUUID } from 'node:crypto'

/** Persisted connection entry. Secrets are referenced, never stored here. */
export interface HubEndpointConfig {
  id: string
  label: string
  uri: string
  credentialRef?: string
  enabled: boolean
  /** Register this node's Host with this Hub. */
  registerAgent?: boolean
}

/** Persisted Hub client configuration. */
export interface HubConnectionSettings {
  endpoints: HubEndpointConfig[]
  selectedWorkspaces: HubWorkspaceRef[]
  agentEndpointId: `remote:${string}`
  agentServerName: string
}

/** Public state exposed to the Web settings surface. */
export interface HubEndpointState extends HubEndpointConfig {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  endpointId?: string
  error?: string
}

export const HUB_CONNECTIONS_NS = settingsNamespace('hub')

/** Schema for the user-owned Hub connection list. */
export const HubConnectionSettingsSchema: Schema<HubConnectionSettings> = Schema.object({
  endpoints: Schema.array(Schema.object({
    id: Schema.string().required(),
    label: Schema.string().required(),
    uri: Schema.string().required(),
    credentialRef: Schema.string().default(''),
    enabled: Schema.boolean().default(true),
    registerAgent: Schema.boolean().default(false),
  })).default([]),
  selectedWorkspaces: Schema.array(Schema.object({ endpointId: Schema.string().required() as Schema<`remote:${string}`>, workspaceId: Schema.string().required() })).default([]),
  agentEndpointId: Schema.string().default('') as Schema<`remote:${string}`>,
  agentServerName: Schema.string().default('deepseek-harness-endpoint'),
})

interface ManagedEndpoint {
  config: HubEndpointConfig
  provider: RemoteSessionProvider
  agent: HubEndpointAgent | undefined
  status: HubEndpointState['status']
  error?: string
}

/**
 * Owns persisted Hub endpoint configuration and provider lifecycles.
 * The browser only calls this service; it never owns a WebSocket.
 */
export class HubConnectionManager {
  private readonly entries = new Map<string, ManagedEndpoint>()
  private readonly settings: SettingsScope<HubConnectionSettings>
  private readonly identityReady: Promise<void>
  private reconcileTail: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: Context, settings: SettingsScope<HubConnectionSettings>) {
    this.settings = settings
    const configuredAgentId = settings.get().agentEndpointId
    this.identityReady = (configuredAgentId as string) === ''
      ? settings.update({ agentEndpointId: `remote:${randomUUID().replaceAll('-', '')}` as `remote:${string}` })
      : Promise.resolve()
    void this.enqueueReconcile(settings.get().endpoints)
    settings.watch((value) => { void this.enqueueReconcile(value.endpoints) })
  }

  /** Return redacted endpoint state for the settings page. */
  list(): HubEndpointState[] {
    return [...this.entries.values()].map(entry => ({
      ...entry.config,
      status: entry.status,
      ...(entry.provider.connectedServerInfo?.endpointId === undefined
        ? {}
        : { endpointId: entry.provider.connectedServerInfo.endpointId }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
    }))
  }

  /** Forward one Hub request through the configured connection that owns its endpoint. */
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const endpointId = typeof params.endpointId === 'string' ? params.endpointId : undefined
    const provider = await this.resolveProvider(endpointId)
    return await provider.request(method, params)
  }

  /** Reconnect all enabled configured Hub connections. */
  async reconnect(): Promise<void> {
    await this.identityReady
    for (const entry of this.entries.values()) {
      if (!entry.config.enabled) continue
      this.disconnect(entry.config.id)
      await this.connect(entry.config.id)
    }
  }

  /** Return the status of the configured Hub connection set. */
  status(): { endpointId: string | null; status: HubEndpointState['status']; isConnected: boolean; uri: string; serverInfo: { name: string; version: string } | null } {
    const connected = [...this.entries.values()].filter(entry => entry.provider.isConnected)
    if (connected.length !== 1) {
      return { endpointId: null, status: connected.length === 0 ? 'disconnected' : 'connected', isConnected: connected.length > 0, uri: '', serverInfo: null }
    }
    const active = connected[0]
    if (active === undefined) throw new Error('connected Hub disappeared')
    const info = active.provider.connectedServerInfo
    return {
      endpointId: info?.endpointId ?? null,
      status: 'connected',
      isConnected: true,
      uri: active.config.uri,
      serverInfo: info?.serverInfo ?? null,
    }
  }

  private async resolveProvider(endpointId: string | undefined): Promise<RemoteSessionProvider> {
    await this.identityReady
    const connected = [...this.entries.values()].filter(entry => entry.provider.isConnected)
    if (endpointId === undefined) {
      if (connected.length !== 1) throw new Error(connected.length === 0 ? 'no Hub connection is available' : 'multiple Hub connections require an endpointId')
      const active = connected[0]
      if (active === undefined) throw new Error('connected Hub disappeared')
      return active.provider
    }
    for (const entry of connected) {
      const result = await entry.provider.request('hub/list-endpoints', {}) as { endpoints?: Array<{ endpointId?: string }> }
      if (result.endpoints?.some(endpoint => endpoint.endpointId === endpointId)) return entry.provider
    }
    throw new Error(`no connected Hub owns endpoint ${endpointId}`)
  }

  /** Return endpoint-qualified homepage workspace selections. */
  selectedWorkspaces(): HubWorkspaceRef[] { return [...this.settings.get().selectedWorkspaces] }

  /** Persist endpoint-qualified homepage workspace selections. */
  async setSelectedWorkspaces(value: HubWorkspaceRef[]): Promise<void> { await this.settings.update({ selectedWorkspaces: value }) }

  /** Store an imported endpoint token through the credential provider. */
  async storeCredential(ref: CredentialRef, value: string): Promise<void> {
    await this.ctx.credentials.set(ref, value)
  }

  /** Add an endpoint and optionally connect it. */
  async create(config: HubEndpointConfig): Promise<HubEndpointState> {
    await this.identityReady
    if (this.entries.has(config.id)) throw new Error(`Hub endpoint "${config.id}" already exists`)
    const endpoints = [...this.settings.get().endpoints, config]
    await this.persist(endpoints)
    await this.enqueueReconcile(endpoints)
    const entry = this.entries.get(config.id)
    if (entry === undefined) throw new Error(`Hub endpoint "${config.id}" was not installed`)
    return this.state(entry)
  }

  /** Update an endpoint, replacing its provider when connection fields change. */
  async update(id: string, patch: Partial<Omit<HubEndpointConfig, 'id'>>): Promise<HubEndpointState> {
    await this.identityReady
    const current = this.entries.get(id)
    if (current === undefined) throw new Error(`Hub endpoint "${id}" not found`)
    const next = { ...current.config, ...patch }
    const endpoints = this.settings.get().endpoints.map(item => item.id === id ? next : item)
    await this.persist(endpoints)
    await this.enqueueReconcile(endpoints)
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`Hub endpoint "${id}" was not installed`)
    return this.state(entry)
  }

  /** Remove an endpoint and close its provider. */
  async delete(id: string): Promise<void> {
    this.disconnect(id)
    if (!this.entries.delete(id)) throw new Error(`Hub endpoint "${id}" not found`)
    await this.persist(this.settings.get().endpoints.filter(item => item.id !== id))
  }

  /** Connect one configured endpoint. */
  async connect(id: string): Promise<HubEndpointState> {
    await this.identityReady
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`Hub endpoint "${id}" not found`)
    entry.status = 'connecting'
    delete entry.error
    try {
      await entry.provider.connect()
      if (entry.config.registerAgent === true) {
        const token = entry.provider.connectionToken
        const apiProxy = this.ctx.get('apiProxy')
        if (apiProxy === undefined) throw new Error('Hub Endpoint Agent requires the Host API')
        const agentEndpointId = this.settings.get().agentEndpointId
        if ((agentEndpointId as string) === '') throw new Error('Hub Endpoint Agent identity is not initialized')
        entry.agent = new HubEndpointAgent({
          uri: entry.config.uri,
          endpointId: agentEndpointId as `remote:${string}`,
          token,
          serverInfo: { name: this.settings.get().agentServerName, version: '0.1.0' },
          apiProxy: apiProxy as never,
          directory: new HubWorkspaceDirectoryProvider(apiProxy as never),
        })
        await entry.agent.connect()
      }
      entry.status = 'connected'
    } catch (error) {
      await entry.agent?.disconnect()
      entry.agent = undefined
      entry.provider.disconnect()
      entry.status = 'error'
      entry.error = error instanceof Error ? error.message : String(error)
      throw error
    }
    return this.state(entry)
  }

  /** Disconnect one endpoint without deleting its configuration. */
  disconnect(id: string): void {
    const entry = this.entries.get(id)
    if (entry === undefined) return
    void entry.agent?.disconnect()
    entry.agent = undefined
    entry.provider.disconnect()
    entry.status = 'disconnected'
  }

  /** Test a connection without changing the enabled flag. */
  async test(config: HubEndpointConfig): Promise<HubEndpointState> {
    await this.identityReady
    const token = await this.resolveToken(config.credentialRef)
    const provider = new RemoteSessionProvider(this.ctx, this.providerConfig(config, token))
    try {
      await provider.connect()
      const endpointId = provider.connectedServerInfo?.endpointId
      return { ...config, status: 'connected', ...(endpointId === undefined ? {} : { endpointId }) }
    } finally {
      provider.disconnect()
    }
  }

  private async install(config: HubEndpointConfig): Promise<void> {
    const entry: ManagedEndpoint = {
      config,
      provider: new RemoteSessionProvider(this.ctx, this.providerConfig(config, await this.resolveToken(config.credentialRef))),
      agent: undefined,
      status: 'disconnected',
    }
    this.entries.set(config.id, entry)
    if (config.enabled) await this.connect(config.id)
  }

  private enqueueReconcile(configs: HubEndpointConfig[]): Promise<void> {
    const task = this.reconcileTail.then(() => this.reconcileNow(configs))
    this.reconcileTail = task.then(() => undefined, () => undefined)
    return task
  }

  private async reconcileNow(configs: HubEndpointConfig[]): Promise<void> {
    const next = new Map(configs.map(config => [config.id, config]))
    for (const id of this.entries.keys()) {
      if (!next.has(id)) {
        this.disconnect(id)
        this.entries.delete(id)
      }
    }
    for (const config of configs) {
      const existing = this.entries.get(config.id)
      if (existing === undefined) await this.install(config)
      else if (JSON.stringify(existing.config) !== JSON.stringify(config)) {
        this.disconnect(config.id)
        this.entries.delete(config.id)
        await this.install(config)
      }
    }
  }

  private state(entry: ManagedEndpoint): HubEndpointState {
    const state = this.list().find(item => item.id === entry.config.id)
    if (state === undefined) throw new Error(`Hub endpoint "${entry.config.id}" was removed`)
    return state
  }

  private providerConfig(config: HubEndpointConfig, token?: string): RemoteHubConfig {
    return { uri: config.uri, ...(token === undefined ? {} : { token }) }
  }

  private async resolveToken(ref: string | undefined): Promise<string | undefined> {
    if (!ref) return undefined
    const resolved = await this.ctx.credentials.resolve(credentialRef(ref) as CredentialRef)
    return resolved?.value
  }

  private async persist(endpoints: HubEndpointConfig[]): Promise<void> {
    await this.settings.update({ endpoints })
  }
}

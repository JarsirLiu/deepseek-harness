import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { RemoteSessionProvider, type RemoteHubConfig } from './remote-session-provider.ts'

/** Persisted connection entry. Secrets are referenced, never stored here. */
export interface HubEndpointConfig {
  id: string
  label: string
  uri: string
  credentialRef?: string
  enabled: boolean
}

/** Persisted Hub client configuration. */
export interface HubConnectionSettings {
  endpoints: HubEndpointConfig[]
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
  })).default([]),
})

interface ManagedEndpoint {
  config: HubEndpointConfig
  provider: RemoteSessionProvider
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

  constructor(private readonly ctx: Context, settings: SettingsScope<HubConnectionSettings>) {
    this.settings = settings
    void this.reconcile(settings.get().endpoints)
    settings.watch((value) => { void this.reconcile(value.endpoints) })
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

  /** Add an endpoint and optionally connect it. */
  async create(config: HubEndpointConfig): Promise<HubEndpointState> {
    if (this.entries.has(config.id)) throw new Error(`Hub endpoint "${config.id}" already exists`)
    const endpoints = [...this.settings.get().endpoints, config]
    await this.persist(endpoints)
    await this.reconcile(endpoints)
    const entry = this.entries.get(config.id)
    if (entry === undefined) throw new Error(`Hub endpoint "${config.id}" was not installed`)
    if (config.enabled) await this.connect(config.id)
    return this.state(entry)
  }

  /** Update an endpoint, replacing its provider when connection fields change. */
  async update(id: string, patch: Partial<Omit<HubEndpointConfig, 'id'>>): Promise<HubEndpointState> {
    const current = this.entries.get(id)
    if (current === undefined) throw new Error(`Hub endpoint "${id}" not found`)
    const next = { ...current.config, ...patch }
    const endpoints = this.settings.get().endpoints.map(item => item.id === id ? next : item)
    await this.persist(endpoints)
    await this.reconcile(endpoints)
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`Hub endpoint "${id}" was not installed`)
    if (next.enabled) await this.connect(id)
    else this.disconnect(id)
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
    const entry = this.entries.get(id)
    if (entry === undefined) throw new Error(`Hub endpoint "${id}" not found`)
    entry.status = 'connecting'
    delete entry.error
    try {
      await entry.provider.connect()
      entry.status = 'connected'
    } catch (error) {
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
    entry.provider.disconnect()
    entry.status = 'disconnected'
  }

  /** Test a connection without changing the enabled flag. */
  async test(config: HubEndpointConfig): Promise<HubEndpointState> {
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
      status: 'disconnected',
    }
    this.entries.set(config.id, entry)
    if (config.enabled) void this.connect(config.id).catch(() => {})
  }

  private async reconcile(configs: HubEndpointConfig[]): Promise<void> {
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
    await this.settings.replace({ endpoints })
  }
}

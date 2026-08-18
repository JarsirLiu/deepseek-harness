import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { HubServer, type HubServerConfig } from './server.ts'
import { ensureHubToken, makeHubConnectionCredential, type HubIdentitySettings } from './identity.ts'

/** Persisted configuration for the local Hub listener. */
export interface HubServerSettings {
  endpointId: `remote:${string}`
  serverName: string
  host: string
  port: number
  credentialRef: string
  enabled: boolean
  credentialEnabled?: boolean
  publicAddress?: string
}

/** Redacted listener state exposed to configuration surfaces. */
export interface HubServerState extends HubServerSettings {
  status: 'stopped' | 'starting' | 'running' | 'error'
  error?: string
}

export const HUB_SERVER_NS = settingsNamespace('hub-server')

/** Settings schema owned by the local Hub listener. */
interface RunningServer {
  server: HubServer
  config: HubServerSettings
}

/** Owns the local Hub listener and applies persisted configuration changes. */
export class HubServerManager {
  private running: RunningServer | undefined
  private stateValue: HubServerState

  constructor(
    private readonly ctx: Context,
    private readonly settings: SettingsScope<HubServerSettings>,
    private readonly createServer: (config: HubServerConfig) => HubServer = config => new HubServer(ctx, config),
  ) {
    const config = settings.get()
    this.stateValue = { ...config, status: 'stopped' }
    settings.watch((next) => { void this.apply(next) })
    if (config.enabled) void this.start().catch(() => {})
  }

  /** Return listener state without credentials. */
  get(): HubServerState { return { ...this.stateValue } }

  /** Persist a validated configuration and apply it immediately. */
  async update(patch: Partial<Omit<HubServerSettings, 'endpointId'>>): Promise<HubServerState> {
    await this.settings.update(patch)
    await this.apply(this.settings.get())
    return this.get()
  }

  /** Start the configured listener. */
  async start(): Promise<HubServerState> {
    const config = this.settings.get()
    if (this.running !== undefined) return this.get()
    return await this.startConfig(config)
  }

  /** Return a reusable credential for this Hub without exposing it in state. */
  async connectionCredential(): Promise<string> {
    const config = this.settings.get()
    if (config.credentialEnabled === false) throw new Error('Hub credential is disabled')
    const token = await ensureHubToken(this.ctx.credentials, this.identity(config))
    return makeHubConnectionCredential(this.identity(config), token, this.connectionUri(config))
  }

  /** Enable the current long-lived credential. */
  async enableCredential(): Promise<HubServerState> {
    await this.settings.update({ credentialEnabled: true })
    await this.apply(this.settings.get())
    return this.get()
  }

  /** Disable the current credential without changing endpoint identity. */
  async disableCredential(): Promise<HubServerState> {
    await this.settings.update({ credentialEnabled: false })
    await this.apply(this.settings.get())
    return this.get()
  }

  /** Generate a new long-lived credential; all previous copies stop working. */
  async regenerateCredential(): Promise<string> {
    const config = this.settings.get()
    const ref = credentialRef(config.credentialRef)
    await this.ctx.credentials.set(ref, `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`)
    await this.settings.update({ credentialEnabled: true })
    await this.apply(this.settings.get())
    return this.connectionCredential()
  }

  private async startConfig(config: HubServerSettings): Promise<HubServerState> {
    this.stateValue = { ...config, status: 'starting' }
    try {
      const server = this.createServer(await this.serverConfig(config))
      server.start()
      await server.waitUntilListening()
      this.running = { server, config }
      this.stateValue = { ...config, status: 'running' }
    } catch (error) {
      this.stateValue = { ...config, status: 'error', error: error instanceof Error ? error.message : String(error) }
      throw error
    }
    return this.get()
  }

  /** Stop the configured listener. */
  async stop(): Promise<HubServerState> {
    const running = this.running
    this.running = undefined
    if (running !== undefined) await running.server.stop()
    this.stateValue = { ...this.settings.get(), status: 'stopped' }
    return this.get()
  }

  /** Test credentials and binding without replacing the active listener. */
  async test(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const config = await this.serverConfig(this.settings.get())
      const server = this.createServer({ ...config, port: 0 })
      server.start()
      await server.waitUntilListening()
      await server.stop()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async apply(config: HubServerSettings): Promise<void> {
    if (!config.enabled) { await this.stop(); return }
    if (this.running !== undefined && JSON.stringify(this.running.config) === JSON.stringify(config)) return
    const previous = this.running?.config
    await this.stop()
    try {
      await this.startConfig(config)
    } catch (error) {
      if (previous !== undefined) {
        try { await this.startConfig(previous) } catch { /* preserve the replacement error */ }
      }
      throw error
    }
  }

  private async serverConfig(config: HubServerSettings): Promise<HubServerConfig> {
    const token = config.credentialEnabled === false ? undefined : config.credentialRef
      ? (await this.ctx.credentials.resolve(credentialRef(config.credentialRef)))?.value
      : undefined
    return {
      endpointId: config.endpointId,
      host: config.host,
      port: config.port,
      serverName: config.serverName,
      authTokens: token === undefined ? [] : [token],
    }
  }

  private identity(config: HubServerSettings): HubIdentitySettings {
    return {
      endpointId: config.endpointId,
      serverName: config.serverName,
      credentialRef: config.credentialRef,
      credentialEnabled: config.credentialEnabled !== false,
    }
  }

  private connectionUri(config: HubServerSettings): string {
    const address = config.publicAddress?.trim() || config.host
    return `ws://${address}:${config.port}/hub`
  }
}

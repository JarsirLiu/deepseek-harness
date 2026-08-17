/**
 * Browser transport owned by the Hub Web bundle.
 *
 * The adapter is endpoint-qualified: callers must provide the owning endpoint
 * in every lookup, and a remote session never falls back to the local API.
 *
 * @module @deepseek-ai/dsh-hub-web-adapter
 */

import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HistoryEntry, MessageId, ModelSelection, MuxFrame, PromptContentPart, QueueAction, RpcResult, SessionId, SessionModels, SubagentAddress, SubagentCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostFrame, SessionProjectionsBlock } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEndpointId, SessionRef } from './endpoint-registry.ts'
export { parseQualifiedSessionId, qualifiedSessionId, sessionKey } from './endpoint-registry.ts'
export type { SessionEndpointId, SessionKey, SessionRef } from './endpoint-registry.ts'
type SubagentPromptReceipt = { messageId: MessageId }
type SubagentInterruptReceipt = { accepted: true }

/** Cordis service key for the remote session transport registry. */
export const REMOTE_SESSION_REGISTRY = 'remoteSessionTransportRegistry'

/** One remote workspace selected for projection into the Web Runtime. */
export interface RemoteWorkspace {
  readonly endpointId: `remote:${string}`
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly sessions: readonly RemoteWorkspaceSession[]
}

/** Workspace reference used to scope one remote endpoint subscription. */
export interface RemoteWorkspaceRef {
  readonly endpointId: `remote:${string}`
  readonly workspaceId: string
}

/** Host frame notification with Hub routing metadata. */
export interface RemoteHostNotification {
  readonly endpointId: `remote:${string}`
  readonly workspaceId: string | null
  readonly frame: HostFrame
}

/** Session metadata projected by the owning remote workspace. */
export interface RemoteWorkspaceSession {
  readonly endpointId: `remote:${string}`
  readonly sessionId: SessionId
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  readonly title?: string
  readonly agentPreset?: string
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
}

/** Browser-facing source of selected remote workspaces. */
export interface RemoteWorkspaceSource {
  /** Return only workspaces explicitly selected by the user. */
  listSelected(): Promise<readonly RemoteWorkspace[]>
  /** Create a session on the owning remote workspace. */
  createSession(workspace: RemoteWorkspace): Promise<SessionId>
  rename(workspace: RemoteWorkspace, title: string): Promise<RemoteWorkspace>
  delete(workspace: RemoteWorkspace): Promise<void>
  insertBefore(workspace: RemoteWorkspace, before?: RemoteWorkspace): Promise<void>
  insertSessionBefore(workspace: RemoteWorkspace, sessionId: SessionId, beforeSessionId?: SessionId): Promise<RemoteWorkspace>
}

/** Cordis service key for the optional remote workspace source. */
export const REMOTE_WORKSPACE_SOURCE = 'remoteWorkspaceSource'

/** A remote stream frame with its publishing endpoint retained outside the Harness wire frame. */
export type RemoteSessionFrame = MuxFrame & { readonly endpointId: `remote:${string}` }

/** Resolve a remote transport without permitting a local fallback.
 * @param transport - the candidate remote transport.
 * @param ref - the endpoint-qualified session reference.
 * @returns the owning transport, or undefined for a local reference.
 */
export function resolveRemoteSessionTransport(
  transport: RemoteSessionTransport | undefined,
  ref: SessionRef,
): RemoteSessionTransport | undefined {
  if (!ref.endpointId.startsWith('remote:')) return undefined
  if (transport === undefined || transport.endpointId !== ref.endpointId || !transport.owns(ref)) {
    throw new Error(`remote endpoint unavailable for session ${String(ref.sessionId)}: ${ref.endpointId}`)
  }
  return transport
}

/** Operations supplied by one remote endpoint transport. */
export interface RemoteSessionTransport {
  readonly endpointId: `remote:${string}`
  owns(ref: SessionRef): boolean
  history(
    workspaceId: string,
    sessionId: SessionId,
    payload: { beforeSeq?: number; maxMessages?: number },
  ): Promise<RpcResult<{ events: HistoryEntry[]; hasMore: boolean }>>
  prompt(
    workspaceId: string,
    sessionId: SessionId,
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
  ): Promise<RpcResult<{ accepted: true }>>
  cancel(workspaceId: string, sessionId: SessionId): Promise<RpcResult<{ accepted: true }>>
  models(workspaceId: string, sessionId: SessionId): Promise<RpcResult<SessionModels>>
  selectModel(workspaceId: string, sessionId: SessionId, selection: ModelSelection): Promise<RpcResult<{ selected: ModelSelection }>>
  rename(workspaceId: string, sessionId: SessionId, title: string): Promise<RpcResult<{ title: string; seq: number }>>
  updateQueue(workspaceId: string, sessionId: SessionId, itemId: MessageId, action: QueueAction): Promise<RpcResult<{ accepted: true }>>
  readAttachment(
    workspaceId: string,
    sessionId: SessionId,
    attachmentId: AttachmentIdType,
  ): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: string }>>
  fork(workspaceId: string, sessionId: SessionId, atSeq?: number): Promise<RpcResult<{ sessionId: SessionId }>>
  archiveSession(workspaceId: string, sessionId: SessionId): Promise<RpcResult<{ archivedSessionIds: SessionId[] }>>
  subagentList(workspaceId: string, parentSessionId: SessionId): Promise<RpcResult<SubagentCatalog>>
  subagentHistory(
    workspaceId: string,
    address: SubagentAddress,
    payload: { beforeSeq?: number; maxMessages?: number },
  ): Promise<RpcResult<{ events: HistoryEntry[]; hasMore: boolean }>>
  subagentPrompt(workspaceId: string, address: Extract<SubagentAddress, { mode: 'continuable' }>, content: PromptContentPart[]): Promise<RpcResult<SubagentPromptReceipt>>
  subagentInterrupt(workspaceId: string, address: Extract<SubagentAddress, { mode: 'continuable' }>): Promise<RpcResult<SubagentInterruptReceipt>>
  subscribe(ref: SessionRef, listener: (frame: MuxFrame) => void): () => void
  subscribeHost(workspaces: readonly RemoteWorkspaceRef[], listener: (notification: RemoteHostNotification) => void): () => void
}

/** Registry of independently configured remote endpoint transports. */
export class RemoteSessionTransportRegistry {
  private readonly transports = new Map<`remote:${string}`, RemoteSessionTransport>()

  /** Register one endpoint and return its disposer.
   * @param transport - the endpoint transport to register.
   * @returns a disposer that removes this registration.
   */
  register(transport: RemoteSessionTransport): () => void {
    const endpointId = transport.endpointId
    if (this.transports.has(endpointId)) {
      throw new Error(`remote endpoint already registered: ${endpointId}`)
    }
    this.transports.set(endpointId, transport)
    return () => {
      if (this.transports.get(endpointId) === transport) this.transports.delete(endpointId)
    }
  }

  /** Resolve the transport that owns one remote session.
   * @param ref - the endpoint-qualified session reference.
   * @returns the owning transport.
   */
  resolve(ref: SessionRef): RemoteSessionTransport {
    if (!ref.endpointId.startsWith('remote:')) {
      throw new Error(`local session cannot use a remote transport: ${String(ref.sessionId)}`)
    }
    const endpointId = ref.endpointId as `remote:${string}`
    const transport = this.transports.get(endpointId)
    if (transport === undefined || !transport.owns(ref)) {
      throw new Error(`remote endpoint unavailable for session ${String(ref.sessionId)}: ${ref.endpointId}`)
    }
    return transport
  }

  /** Return all currently registered endpoint identities.
   * @returns the registered remote endpoint identities.
   */
  endpoints(): readonly `remote:${string}`[] {
    return [...this.transports.keys()]
  }

  /** Resolve a registered endpoint before a session exists.
   * @param endpointId - the remote endpoint identity.
   * @returns the registered transport, if present.
   */
  get(endpointId: `remote:${string}`): RemoteSessionTransport | undefined {
    return this.transports.get(endpointId)
  }
}

function failure<T>(response: Response): RpcResult<T> {
  return { ok: false, error: { code: 'internal', message: `HTTP ${response.status}`, details: {} } }
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<RpcResult<T>> {
  const response = await globalThis.fetch('/api/hub/rpc', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  if (!response.ok) return failure(response)
  const body = await response.json() as { result?: RpcResult<T> }
  if (body.result !== undefined) return body.result
  return { ok: false, error: { code: 'internal', message: 'Hub API response is missing result', details: {} } }
}

/** Create the Web transport for one configured Hub endpoint.
 * @param endpointId - the endpoint identity or a resolver for it.
 * @returns the endpoint's Web transport.
 */
export function createRemoteSessionTransport(endpointId: SessionEndpointId | (() => SessionEndpointId)): RemoteSessionTransport {
  const resolveEndpoint = typeof endpointId === 'function' ? endpointId : () => endpointId
  if (!resolveEndpoint().startsWith('remote:')) throw new Error(`Hub Web adapter requires a remote endpoint: ${resolveEndpoint()}`)
  let eventSource: EventSource | undefined
  const eventListeners = new Map<string, Set<(frame: MuxFrame) => void>>()
  const closeEvents = (): void => {
    if (eventListeners.size !== 0) return
    eventSource?.close()
    eventSource = undefined
  }
  const openEvents = (): void => {
    if (eventSource !== undefined) return
    eventSource = new EventSource('/api/hub/events.mux')
    eventSource.onmessage = (event) => {
      const notification = parseEventData(event.data) as { endpointId: `remote:${string}`; workspaceId: string; event: Record<string, unknown>; sessionId: SessionId }
      const listeners = eventListeners.get(`${notification.workspaceId}\u0000${String(notification.sessionId)}`)
      if (listeners === undefined) return
      const frame = { type: 'session/event', sessionId: notification.sessionId, event: notification.event as never, endpointId: notification.endpointId } as RemoteSessionFrame
      for (const listener of listeners) listener(frame)
    }
    eventSource.onerror = () => {
      eventSource?.close()
      eventSource = undefined
      if (eventListeners.size !== 0) openEvents()
    }
  }
  return {
    get endpointId() { return resolveEndpoint() as `remote:${string}` },
    owns: ref => ref.endpointId === resolveEndpoint(),
    history: async (workspaceId, sessionId, payload) => {
      const result = await call<RemoteHistoryResponse>('hub/api/request', {
        endpointId: resolveEndpoint(), workspaceId,
        method: 'session.history',
        payload: { sessionId, ...payload },
      })
      if (!result.ok) return result
      return {
        ok: true,
        value: {
          events: result.value.events,
          hasMore: result.value.hasMore,
          ...(result.value.projections === undefined ? {} : { projections: result.value.projections }),
        },
      }
    },
    prompt: (workspaceId, sessionId, content, mode) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'session.prompt', payload: { sessionId, content, mode } }),
    cancel: (workspaceId, sessionId) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'session.cancel', payload: { sessionId } }),
    models: (workspaceId, sessionId) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'session.models', payload: { sessionId } }),
    selectModel: (workspaceId, sessionId, selection) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'session.selectModel', payload: { sessionId, ...selection } }),
    rename: (workspaceId, sessionId, title) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'session.rename', payload: { sessionId, title } }),
    updateQueue: (workspaceId, sessionId, itemId, action) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'session.updateQueue', payload: { sessionId, itemId, action } }),
    readAttachment: (workspaceId, sessionId, attachmentId) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'session.attachment', payload: { sessionId, attachmentId } }),
    fork: (workspaceId, sessionId, atSeq) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'session.fork', payload: { sessionId, ...(atSeq === undefined ? {} : { atSeq }) } }),
    archiveSession: (workspaceId, sessionId) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'workspace.archiveSession', payload: { sessionId } }),
    subagentList: (workspaceId, parentSessionId) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'subagent.list', payload: { parentSessionId } }),
    subagentHistory: (workspaceId, address, payload) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'subagent.history', payload: { ...address, ...payload } }),
    subagentPrompt: (workspaceId, address, content) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'subagent.prompt', payload: { ...address, content } }),
    subagentInterrupt: (workspaceId, address) => call('hub/api/request', { endpointId: resolveEndpoint(), workspaceId, method: 'subagent.interrupt', payload: address }),
    subscribe: (ref, listener) => {
      const key = `${ref.workspaceId}\u0000${String(ref.sessionId)}`
      const listeners = eventListeners.get(key) ?? new Set<(frame: MuxFrame) => void>()
      eventListeners.set(key, listeners)
      listeners.add(listener)
      openEvents()
      return () => {
        const current = eventListeners.get(key)
        if (current?.delete(listener) && current.size === 0) eventListeners.delete(key)
        closeEvents()
      }
    },
    subscribeHost: (workspaces, listener) => {
      const workspaceSet = new Set(workspaces.map(workspace => `${workspace.endpointId}\u0000${workspace.workspaceId}`))
      const source = new EventSource('/api/hub/host/stream')
      source.onmessage = (event) => {
        const notification = parseEventData(event.data) as RemoteHostNotification
        if (notification.workspaceId !== null
          && !workspaceSet.has(`${notification.endpointId}\u0000${notification.workspaceId}`)) return
        listener(notification)
      }
      return () => { source.close() }
    },
  }
}

function parseEventData(data: unknown): unknown {
  if (typeof data !== 'string') throw new Error('Hub event data must be JSON text')
  return JSON.parse(data)
}

type RemoteHistoryResponse = {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: SessionProjectionsBlock
}

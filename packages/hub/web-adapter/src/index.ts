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
import type { SessionEndpointId, SessionRef } from './endpoint-registry.ts'
export { SessionEndpointRegistry, parseQualifiedSessionId, qualifiedSessionId, sessionKey } from './endpoint-registry.ts'
export type { SessionEndpointId, SessionKey, SessionRef } from './endpoint-registry.ts'
type SubagentPromptReceipt = { messageId: MessageId }
type SubagentInterruptReceipt = { accepted: true }

export const REMOTE_SESSION_REGISTRY = 'remoteSessionTransportRegistry'

/** One remote workspace selected for projection into the Web Runtime. */
export interface RemoteWorkspace {
  readonly endpointId: `remote:${string}`
  readonly workspaceId: string
  readonly title: string
  readonly path: string
  readonly sessions: readonly RemoteWorkspaceSession[]
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
}

/** Cordis service key for the optional remote workspace source. */
export const REMOTE_WORKSPACE_SOURCE = 'remoteWorkspaceSource'

/** A remote stream frame with its publishing endpoint retained outside the Harness wire frame. */
export type RemoteSessionFrame = MuxFrame & { readonly endpointId: `remote:${string}` }

/** Resolve a remote transport without permitting a local fallback. */
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

export interface RemoteSessionTransport {
  readonly endpointId: `remote:${string}`
  owns(ref: SessionRef): boolean
  history(
    sessionId: SessionId,
    payload: { beforeSeq?: number; maxMessages?: number },
  ): Promise<RpcResult<{ events: HistoryEntry[]; hasMore: boolean }>>
  prompt(
    sessionId: SessionId,
    content: PromptContentPart[],
    mode: 'queue' | 'steer',
  ): Promise<RpcResult<{ accepted: true }>>
  cancel(sessionId: SessionId): Promise<RpcResult<{ accepted: true }>>
  models(sessionId: SessionId): Promise<RpcResult<SessionModels>>
  selectModel(sessionId: SessionId, selection: ModelSelection): Promise<RpcResult<{ selected: ModelSelection }>>
  rename(sessionId: SessionId, title: string): Promise<RpcResult<{ title: string; seq: number }>>
  updateQueue(sessionId: SessionId, itemId: MessageId, action: QueueAction): Promise<RpcResult<{ accepted: true }>>
  readAttachment(
    sessionId: SessionId,
    attachmentId: AttachmentIdType,
  ): Promise<RpcResult<{ attachment: ImageAttachmentRef; data: string }>>
  fork(sessionId: SessionId, atSeq?: number): Promise<RpcResult<{ sessionId: SessionId }>>
  subagentList(parentSessionId: SessionId): Promise<RpcResult<SubagentCatalog>>
  subagentHistory(
    address: SubagentAddress,
    payload: { beforeSeq?: number; maxMessages?: number },
  ): Promise<RpcResult<{ events: HistoryEntry[]; hasMore: boolean }>>
  subagentPrompt(address: Extract<SubagentAddress, { mode: 'continuable' }>, content: PromptContentPart[]): Promise<RpcResult<SubagentPromptReceipt>>
  subagentInterrupt(address: Extract<SubagentAddress, { mode: 'continuable' }>): Promise<RpcResult<SubagentInterruptReceipt>>
  subscribe(sessionId: SessionId, listener: (frame: MuxFrame) => void): () => void
}

/** Registry of independently configured remote endpoint transports. */
export class RemoteSessionTransportRegistry {
  private readonly transports = new Map<`remote:${string}`, RemoteSessionTransport>()

  /** Register one endpoint and return its disposer. */
  register(transport: RemoteSessionTransport): () => void {
    const endpointId = transport.endpointId as `remote:${string}`
    if (this.transports.has(endpointId)) {
      throw new Error(`remote endpoint already registered: ${endpointId}`)
    }
    this.transports.set(endpointId, transport)
    return () => {
      if (this.transports.get(endpointId) === transport) this.transports.delete(endpointId)
    }
  }

  /** Resolve the transport that owns one remote session. */
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

  /** Return all currently registered endpoint identities. */
  endpoints(): readonly `remote:${string}`[] {
    return [...this.transports.keys()]
  }
}

function failure<T>(response: Response): RpcResult<T> {
  return { ok: false, error: { code: 'internal', message: `HTTP ${response.status}`, details: {} } }
}

async function get<T>(path: string): Promise<RpcResult<T>> {
  const response = await globalThis.fetch(path, { credentials: 'same-origin' })
  if (!response.ok) return failure(response)
  return { ok: true, value: await response.json() as T }
}

function encode(value: unknown): string {
  return encodeURIComponent(String(value))
}

/** Create the Web transport for one configured Hub endpoint. */
export function createRemoteSessionTransport(endpointId: SessionEndpointId | (() => SessionEndpointId)): RemoteSessionTransport {
  const resolveEndpoint = typeof endpointId === 'function' ? endpointId : () => endpointId
  if (!resolveEndpoint().startsWith('remote:')) throw new Error(`Hub Web adapter requires a remote endpoint: ${resolveEndpoint()}`)
  return {
    get endpointId() { return resolveEndpoint() as `remote:${string}` },
    owns: ref => ref.endpointId === resolveEndpoint(),
    history: async (sessionId, payload) => {
      const result = await get<RemoteHistoryResponse>(`/api/hub/session/load?id=${encode(sessionId)}`)
      if (!result.ok) return result
      return {
        ok: true,
        value: {
          events: normalizeHistory(result.value.events, payload),
          hasMore: false,
        },
      }
    },
    prompt: async (sessionId, content, mode) => {
      const text = content.filter((part): part is Extract<PromptContentPart, { type: 'text' }> => part.type === 'text').map(part => part.text).join('\n')
      return get(`/api/hub/session/message?id=${encode(sessionId)}&text=${encode(text)}&mode=${encode(mode)}`)
    },
    cancel: sessionId => get(`/api/hub/session/cancel?id=${encode(sessionId)}`),
    models: sessionId => get(`/api/hub/session/models?id=${encode(sessionId)}`),
    selectModel: (sessionId, selection) => get(`/api/hub/session/select-model?id=${encode(sessionId)}&provider=${encode(selection.provider)}&model=${encode(selection.model)}${selection.reasoningEffort === undefined ? '' : `&reasoningEffort=${encode(selection.reasoningEffort)}`}`),
    rename: (sessionId, title) => get(`/api/hub/session/rename?id=${encode(sessionId)}&title=${encode(title)}`),
    updateQueue: (sessionId, itemId, action) => get(`/api/hub/session/update-queue?id=${encode(sessionId)}&itemId=${encode(itemId)}&action=${encode(JSON.stringify(action))}`),
    readAttachment: (sessionId, attachmentId) => get(`/api/hub/session/attachment?id=${encode(sessionId)}&attachmentId=${encode(attachmentId)}`),
    fork: (sessionId, atSeq) => get(`/api/hub/session/fork?id=${encode(sessionId)}${atSeq === undefined ? '' : `&atSeq=${encode(atSeq)}`}`),
    subagentList: parentSessionId => get(`/api/hub/subagent/list?parentSessionId=${encode(parentSessionId)}`),
    subagentHistory: (address, payload) => get(`/api/hub/subagent/history?parentSessionId=${encode(address.parentSessionId)}&childSessionId=${encode(address.childSessionId)}&mode=${encode(address.mode)}${payload.beforeSeq === undefined ? '' : `&beforeSeq=${encode(payload.beforeSeq)}`}${payload.maxMessages === undefined ? '' : `&maxMessages=${encode(payload.maxMessages)}`}`),
    subagentPrompt: (address, content) => get(`/api/hub/subagent/prompt?parentSessionId=${encode(address.parentSessionId)}&childSessionId=${encode(address.childSessionId)}&mode=${encode(address.mode)}&content=${encode(JSON.stringify(content))}`),
    subagentInterrupt: address => get(`/api/hub/subagent/interrupt?parentSessionId=${encode(address.parentSessionId)}&childSessionId=${encode(address.childSessionId)}&mode=${encode(address.mode)}`),
    subscribe: (sessionId, listener) => {
      const source = new EventSource(`/api/hub/session/stream?id=${encode(sessionId)}`)
      source.onmessage = (event) => {
        const notification = JSON.parse(event.data) as { endpointId: `remote:${string}`; event: Record<string, unknown> }
        listener({ type: 'session/event', sessionId, event: notification.event as never, endpointId: notification.endpointId } as RemoteSessionFrame)
      }
      return () => source.close()
    },
  }
}

type RemoteHistoryResponse = {
  events: readonly (HistoryEntry | import('@deepseek-ai/dsh-session').SessionEvent)[]
}

function normalizeHistory(
  events: readonly (HistoryEntry | import('@deepseek-ai/dsh-session').SessionEvent)[],
  payload: { beforeSeq?: number; maxMessages?: number },
): HistoryEntry[] {
  const entries = events.map((entry): HistoryEntry => 'event' in entry
    ? entry
    : { event: entry })
  const beforeSeq = payload.beforeSeq
  const before = beforeSeq === undefined
    ? entries.length
    : entries.findIndex(entry => entry.event.seq >= beforeSeq)
  const end = before === -1 ? entries.length : before
  const start = payload.maxMessages === undefined ? 0 : Math.max(0, end - payload.maxMessages)
  return entries.slice(start, end)
}

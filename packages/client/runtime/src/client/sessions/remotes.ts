/**
 * Remote namespaces the Session cluster calls. One parameter for one concept:
 * the generated surface a Session and its manager reach the Host through.
 *
 * @module @deepseek-ai/dsh-client-runtime/client/sessions/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { AttachmentIdType, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HistoryEntry, IApiClient, MessageId, ModelSelection, PromptContentPart, RpcId, RpcResponse, SessionId, SessionModels, QueueAction, SubagentAddress, SubagentCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { parseQualifiedSessionId, type RemoteSessionTransport, type SessionRef } from '@deepseek-ai/dsh-hub-web-adapter'

/** The generated Remote namespaces a Session and its manager call. */
export type SessionRemotes = Pick<Context['remote'], 'commands'>

/** Operations required by a Session regardless of its owning endpoint. */
export interface SessionTransport {
  history(payload: { beforeSeq?: number; maxMessages?: number }): Promise<RpcResponse<{ events: HistoryEntry[]; hasMore: boolean }>>
  prompt(content: PromptContentPart[], mode: 'queue' | 'steer', clientTimeZone?: string): Promise<RpcResponse<{ accepted: true }>>
  cancel(): Promise<RpcResponse<{ accepted: true }>>
  rename(title: string): Promise<RpcResponse<{ title: string; seq: number }>>
  updateQueue(itemId: MessageId, action: QueueAction): Promise<RpcResponse<{ accepted: true }>>
  readAttachment(attachmentId: AttachmentIdType): Promise<RpcResponse<{ attachment: ImageAttachmentRef; data: string }>>
  models(): Promise<RpcResponse<SessionModels>>
  selectModel(selection: ModelSelection): Promise<RpcResponse<{ selected: ModelSelection }>>
  subagentList(): Promise<RpcResponse<SubagentCatalog>>
  subagentHistory(
    address: SubagentAddress,
    payload: { beforeSeq?: number; maxMessages?: number },
  ): Promise<RpcResponse<{ events: HistoryEntry[]; hasMore: boolean }>>
  subagentPrompt(
    address: Extract<SubagentAddress, { mode: 'continuable' }>,
    content: PromptContentPart[],
    clientTimeZone?: string,
  ): Promise<RpcResponse<{ messageId: MessageId }>>
  subagentInterrupt(address: Extract<SubagentAddress, { mode: 'continuable' }>): Promise<RpcResponse<{ accepted: true }>>
}

/** Build the local transport from the official Host API. */
export function localSessionTransport(api: IApiClient, sessionId: SessionId): SessionTransport {
  return {
    history: payload => api.sessions.history({ sessionId, ...payload }),
    prompt: (content, mode, clientTimeZone) => api.sessions.prompt({
      sessionId, mode, content,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }),
    cancel: () => api.sessions.cancel({ sessionId }),
    rename: title => api.sessions.rename({ sessionId, title }),
    updateQueue: (itemId, action) => api.sessions.updateQueue({ sessionId, itemId, action }),
    readAttachment: attachmentId => api.sessions.attachment({ sessionId, attachmentId }),
    models: () => api.sessions.models({ sessionId }),
    selectModel: selection => api.sessions.selectModel({ sessionId, ...selection }),
    subagentList: () => api.subagents.list({ parentSessionId: sessionId }),
    subagentHistory: (address, payload) => api.subagents.history({ ...address, ...payload }),
    subagentPrompt: (address, content, clientTimeZone) => api.subagents.prompt({ ...address, content: content.filter((part): part is Extract<PromptContentPart, { type: 'text' }> => part.type === 'text'), ...(clientTimeZone === undefined ? {} : { clientTimeZone }) }),
    subagentInterrupt: address => api.subagents.interrupt(address),
  }
}

/** Adapt one endpoint-owned Hub transport to the Runtime Session interface. */
export function remoteSessionTransport(transport: RemoteSessionTransport, ref: SessionRef): SessionTransport {
  if (!transport.owns(ref)) throw new Error(`remote transport does not own session ${String(ref.sessionId)}`)
  const id = ref.sessionId
  return {
    history: payload => asResponse(transport.history(id, payload)),
    prompt: (content, mode) => asResponse(transport.prompt(id, content, mode)),
    cancel: () => asResponse(transport.cancel(id)),
    rename: title => asResponse(transport.rename(id, title)),
    updateQueue: (itemId, action) => asResponse(transport.updateQueue(id, itemId, action)),
    readAttachment: attachmentId => asResponse(transport.readAttachment(id, attachmentId)),
    models: () => asResponse(transport.models(id)),
    selectModel: selection => asResponse(transport.selectModel(id, selection)),
    subagentList: () => asResponse(transport.subagentList(id)),
    subagentHistory: (address, payload) => asResponse(transport.subagentHistory(toRemoteAddress(address, ref), payload)),
    subagentPrompt: (address, content) => asResponse(transport.subagentPrompt(toRemoteAddress(address, ref) as Extract<SubagentAddress, { mode: 'continuable' }>, content)),
    subagentInterrupt: address => asResponse(transport.subagentInterrupt(toRemoteAddress(address, ref) as Extract<SubagentAddress, { mode: 'continuable' }>)),
  }
}

function toRemoteAddress(address: SubagentAddress, ref: SessionRef): SubagentAddress {
  const child = parseQualifiedSessionId(address.childSessionId)
  return {
    ...address,
    parentSessionId: ref.sessionId,
    childSessionId: child?.sessionId ?? address.childSessionId,
  }
}

async function asResponse<T>(result: Promise<import('@deepseek-ai/dsh-api-remotes/client').RpcResult<T>>): Promise<RpcResponse<T>> {
  return { rpcId: 'hub-adapter' as RpcId, result: await result }
}

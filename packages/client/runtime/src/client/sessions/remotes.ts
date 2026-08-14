/**
 * Remote namespaces the Session cluster calls. One parameter for one concept:
 * the generated surface a Session and its manager reach the Host through.
 *
 * @module @deepseek-ai/dsh-client-runtime/client/sessions/remotes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { HistoryEntry, MuxFrame, PromptContentPart, RpcResult, SessionId } from '@deepseek-ai/dsh-api-remotes/client'

/** The generated Remote namespaces a Session and its manager call. */
export type SessionRemotes = Pick<Context['remote'], 'commands'>

/** Browser-side transport supplied by an optional remote-session plugin. */
export interface RemoteSessionRouter {
  /** Whether this router owns the session id. */
  owns(sessionId: SessionId): boolean
  /** Load the remote session history through the plugin transport. */
  history(
    sessionId: SessionId,
    payload: { beforeSeq?: number; maxMessages?: number },
  ): Promise<RpcResult<{ events: HistoryEntry[]; hasMore: boolean }>>
  /** Send one prompt to the remote Agent. */
  prompt(sessionId: SessionId, content: PromptContentPart[], mode: 'queue' | 'steer'): Promise<RpcResult<{ accepted: true }>>
  /** Cancel the remote Agent turn. */
  cancel(sessionId: SessionId): Promise<RpcResult<{ accepted: true }>>
  /** Subscribe to remote session events. */
  subscribe(sessionId: SessionId, listener: (frame: MuxFrame) => void): () => void
}

/** Runtime service key used by the router lookup. */
export const REMOTE_SESSION_ROUTER = 'remoteSessionRouter'

import type { HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session'

export type WorkspaceSubscriptionEntry = { id: string; path?: string; sessionIds: SessionId[] }

/** Decide whether one Host frame belongs to the workspaces selected by a client. */
export function isHostFrameVisibleToWorkspaces(
  frame: HostFrame,
  workspaceIds: ReadonlySet<string>,
  workspaces: readonly WorkspaceSubscriptionEntry[],
): boolean {
  if (workspaceIds.size === 0) return false
  if (frame.type === 'host/remote-event' || frame.type === 'stream/error') return true
  if (frame.type === 'host/workspace-changed') return workspaceIds.has(frame.workspace.workspaceId)
  if (frame.type === 'host/workspace-removed') return workspaceIds.has(frame.workspaceId)
  if (frame.type === 'host/workspace-order-changed') return frame.workspaceIds.some(id => workspaceIds.has(id))
  if (frame.type === 'host/archived-sessions-changed') {
    return frame.archivedSessionIds.some(sessionId => workspaces.some(workspace =>
      workspaceIds.has(workspace.id) && workspace.sessionIds.includes(sessionId)))
  }
  return workspaces.some(workspace => workspaceIds.has(workspace.id)
    && (workspace.sessionIds.includes(frame.sessionId)
      || (frame.type === 'host/session-added'
        && frame.cwd !== undefined
        && workspace.path === frame.cwd)))
}

import type { HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Host workspace metadata used to filter endpoint event frames. */
export type WorkspaceSubscriptionEntry = { id: string; path?: string; sessionIds: SessionId[] }

/** Return the workspace identities that own one Host frame.
 * @param frame - the Host event frame to inspect.
 * @param workspaces - current Host workspace metadata.
 * @returns matching workspace ids; an empty result means endpoint-wide.
 */
export function hostFrameWorkspaceIds(
  frame: HostFrame,
  workspaces: readonly WorkspaceSubscriptionEntry[],
): readonly string[] {
  if (frame.type === 'host/remote-event' || frame.type === 'stream/error') return []
  if (frame.type === 'host/workspace-changed') return [frame.workspace.workspaceId]
  if (frame.type === 'host/workspace-removed') return [frame.workspaceId]
  if (frame.type === 'host/workspace-order-changed') return frame.workspaceIds
  if (frame.type === 'host/archived-sessions-changed') {
    return workspaces
      .filter(workspace => frame.archivedSessionIds.some(sessionId => workspace.sessionIds.includes(sessionId)))
      .map(workspace => workspace.id)
  }
  return workspaces
    .filter(workspace => workspace.sessionIds.includes(frame.sessionId)
      || (frame.type === 'host/session-added' && frame.cwd !== undefined && workspace.path === frame.cwd))
    .map(workspace => workspace.id)
}

/** Decide whether one Host frame belongs to the workspaces selected by a client.
 * @param frame - the Host event frame to inspect.
 * @param workspaceIds - workspace identities selected by the client.
 * @param workspaces - current Host workspace metadata.
 * @returns whether the frame is visible to the selected workspaces.
 */
export function isHostFrameVisibleToWorkspaces(
  frame: HostFrame,
  workspaceIds: ReadonlySet<string>,
  workspaces: readonly WorkspaceSubscriptionEntry[],
): boolean {
  if (workspaceIds.size === 0) return false
  const owners = hostFrameWorkspaceIds(frame, workspaces)
  if (frame.type === 'host/remote-event' || frame.type === 'stream/error') return true
  return owners.some(id => workspaceIds.has(id))
}

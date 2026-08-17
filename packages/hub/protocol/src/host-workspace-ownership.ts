import type { HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Workspace membership required to identify the owner of a Host frame. */
export interface HubWorkspaceOwnershipEntry {
  /** Stable workspace identity. */
  id: string
  /** Workspace path used to identify a newly created session. */
  path?: string
  /** Sessions currently assigned to this workspace. */
  sessionIds: readonly SessionId[]
}

/** Return the workspace identities that own one Host frame.
 * @param frame - Host event frame to inspect.
 * @param workspaces - current workspace membership.
 * @returns matching workspace ids; an empty result means endpoint-wide or unknown ownership.
 */
export function hostFrameWorkspaceIds(
  frame: HostFrame,
  workspaces: readonly HubWorkspaceOwnershipEntry[],
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

/** Whether an empty owner set is valid for a Host frame. */
export function isEndpointWideHostFrame(frame: HostFrame): boolean {
  return frame.type === 'host/remote-event' || frame.type === 'stream/error'
}

/** Decide whether one Host frame belongs to selected workspaces.
 * @param frame - Host event frame to inspect.
 * @param workspaceIds - selected workspace identities.
 * @param workspaces - current workspace membership.
 * @returns whether the frame is visible to the selected workspaces.
 */
export function isHostFrameVisibleToWorkspaces(
  frame: HostFrame,
  workspaceIds: ReadonlySet<string>,
  workspaces: readonly HubWorkspaceOwnershipEntry[],
): boolean {
  if (workspaceIds.size === 0) return false
  const owners = hostFrameWorkspaceIds(frame, workspaces)
  return isEndpointWideHostFrame(frame) || owners.some(id => workspaceIds.has(id))
}

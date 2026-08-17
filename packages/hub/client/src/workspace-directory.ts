/** Authoritative Hub workspace directory derived from the Host API. */

import type { ApiProxy, SessionSummary } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HubWorkspaceEntry } from '@deepseek-ai/dsh-hub-protocol'

/** One workspace summary before the Agent attaches its Endpoint identity. */
export type HubWorkspaceDirectoryEntry = Omit<HubWorkspaceEntry, 'endpointId' | 'sessions'> & {
  sessions: Array<Omit<HubWorkspaceEntry['sessions'][number], 'endpointId'>>
}

/** Source of complete current workspace summaries for an Endpoint Agent. */
export interface HubWorkspaceDirectory {
  /** Read the complete authoritative directory. */
  snapshot(): Promise<HubWorkspaceDirectoryEntry[]>
}

/** Reads a complete workspace directory for one Endpoint Agent.
 * @param apiProxy - local Host API used for the two authoritative list calls.
 */
export class HubWorkspaceDirectoryProvider implements HubWorkspaceDirectory {
  constructor(private readonly apiProxy: Pick<ApiProxy, 'sessions' | 'workspace'>) {}

  /** Read the current complete directory from the Host.
   * @returns workspace summaries suitable for one Endpoint Agent publication.
   */
  async snapshot(): Promise<HubWorkspaceDirectoryEntry[]> {
    const [workspaceResponse, sessionResponse] = await Promise.all([
      this.apiProxy.workspace.list({ rpcId: 'hub-agent-workspace-list' as never, payload: {} }),
      this.apiProxy.sessions.list({ rpcId: 'hub-agent-session-list' as never, payload: {} }),
    ])
    if (!workspaceResponse.result.ok) throw new Error(`Endpoint Agent workspace directory failed: ${workspaceResponse.result.error.message}`)
    if (!sessionResponse.result.ok) throw new Error(`Endpoint Agent session directory failed: ${sessionResponse.result.error.message}`)
    const sessions = new Map(sessionResponse.result.value.items.map(session => [session.sessionId, session]))
    return workspaceResponse.result.value.items.map(workspace => ({
      id: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      sessions: workspace.sessionIds.flatMap((sessionId) => {
        const session = sessions.get(sessionId)
        return session === undefined ? [] : [toHubWorkspaceSession(session)]
      }),
    }))
  }
}

/** Convert the Host's session-list summary without inventing directory fields. */
function toHubWorkspaceSession(session: SessionSummary): HubWorkspaceDirectoryEntry['sessions'][number] {
  const title = (session.projections?.values as Record<string, unknown> | undefined)?.title
  return {
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    running: session.running,
    blank: session.blank,
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(typeof title === 'string' ? { title } : {}),
    ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.origin === undefined ? {} : { origin: session.origin }),
  }
}

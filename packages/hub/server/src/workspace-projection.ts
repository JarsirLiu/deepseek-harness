/**
 * Projects authoritative workspace directories into Hub workspace results.
 *
 * @module @deepseek-ai/dsh-hub-server/workspace-projection
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { HubWorkspaceEntry, HubWorkspaceListResult, HubWorkspaceRef, HubWorkspaceSession } from '@deepseek-ai/dsh-hub-protocol'

type SessionSummary = HubWorkspaceSession & { projections?: { values?: { title?: string | null } } }

/** Local workspace data needed for projection. */
export interface LocalWorkspaceDirectory {
  list(): Array<{ id: string; title: string; path: string; sessionIds: SessionId[] }>
  archivedSessionIds: readonly SessionId[]
}

/** Official Host session APIs used to enrich local workspace summaries. */
export interface WorkspaceProjectionApi {
  sessions: {
    list(request: { rpcId: string; payload: Record<string, never> }): Promise<SessionListResponse>
    history(request: { rpcId: string; payload: { sessionId: SessionId; maxMessages: number } }): Promise<SessionHistoryResponse>
  }
}

type SessionListResponse = { result: { ok: true; value: { items: SessionSummary[] } } | { ok: false; error: unknown } }
type SessionHistoryResponse = {
  result: { ok: true; value: { projections?: { values?: { title?: string | null } } } } | { ok: false; error: unknown }
}

/** Input for an endpoint-qualified workspace projection. */
export interface WorkspaceProjectionInput {
  endpointId: `remote:${string}`
  registry?: LocalWorkspaceDirectory | undefined
  api?: WorkspaceProjectionApi | undefined
  agentWorkspaces: readonly HubWorkspaceEntry[]
  selected?: readonly HubWorkspaceRef[] | undefined
  createRpcId(): string
}

/**
 * Build the selected workspace projection without changing endpoint-owned data.
 * @param input Endpoint-owned directories and local Host query dependencies.
 * @returns Workspace list returned by the Hub protocol.
 */
export async function projectWorkspaces(input: WorkspaceProjectionInput): Promise<HubWorkspaceListResult> {
  const api = input.api
  const summaries = api === undefined
    ? []
    : await api.sessions.list({ rpcId: input.createRpcId(), payload: {} }).then((response) => {
      if (!response.result.ok) throw new Error(`remote session listing failed: ${JSON.stringify(response.result.error)}`)
      return response.result.value.items
    })
  const summariesById = new Map(await Promise.all(summaries.map(async (summary) => {
    if (hasTitle(summary)) return [String(summary.sessionId), summary] as const
    if (api === undefined) return [String(summary.sessionId), summary] as const
    const history = await api.sessions.history({ rpcId: input.createRpcId(), payload: { sessionId: summary.sessionId, maxMessages: 1 } })
    if (!history.result.ok || !hasTitle(history.result.value)) return [String(summary.sessionId), summary] as const
    const title = history.result.value.projections.values.title
    const enriched: SessionSummary = { ...summary, projections: { values: { title } } }
    return [String(summary.sessionId), enriched] as const
  })))
  const archived = new Set(input.registry?.archivedSessionIds ?? [])
  const selected = input.selected === undefined ? undefined : new Set(input.selected.map(workspaceKey))
  const localWorkspaces: ProjectableWorkspace[] = input.registry?.list().map(workspace => ({
    endpointId: input.endpointId,
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    sessions: workspace.sessionIds,
  })) ?? []
  const workspaces: ProjectableWorkspace[] = [...localWorkspaces, ...input.agentWorkspaces]
  return {
    endpointId: input.endpointId,
    workspaces: workspaces
      .filter(workspace => selected === undefined || selected.has(workspaceKey({
        endpointId: workspace.endpointId,
        workspaceId: workspace.id,
      })))
      .map(workspace => ({ ...workspace, sessions: projectSessions(workspace, summariesById, archived) })),
  }
}

interface ProjectableWorkspace {
  endpointId: `remote:${string}`
  id: string
  title: string
  path: string
  sessions: ReadonlyArray<SessionId | HubWorkspaceSession>
}

function projectSessions(
  workspace: ProjectableWorkspace,
  summariesById: ReadonlyMap<string, SessionSummary>,
  archived: ReadonlySet<SessionId>,
): HubWorkspaceSession[] {
  return workspace.sessions.flatMap((session) => {
    const sessionId = typeof session === 'string' ? session : session.sessionId
    if (archived.has(sessionId)) return []
    if (typeof session !== 'string') return [session]
    const summary = summariesById.get(String(sessionId))
    return summary === undefined ? [] : [withTitle({ ...summary, endpointId: workspace.endpointId })]
  })
}

function withTitle(summary: SessionSummary): HubWorkspaceSession {
  const title = summary.projections?.values?.title
  return {
    sessionId: summary.sessionId,
    endpointId: summary.endpointId,
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    ...(typeof title === 'string' && title !== '' ? { title } : {}),
    ...(summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset }),
    ...(summary.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId }),
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
  }
}

function hasTitle(
  value: { projections?: { values?: { title?: string | null } } },
): value is { projections: { values: { title: string } } } {
  const title = value.projections?.values?.title
  return typeof title === 'string' && title !== ''
}

function workspaceKey(workspace: HubWorkspaceRef): string {
  return `${workspace.endpointId}\u0000${workspace.workspaceId}`
}

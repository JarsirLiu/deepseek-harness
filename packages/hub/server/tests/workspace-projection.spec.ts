import { describe, expect, it, vi } from 'vitest'
import { projectWorkspaces } from '../src/workspace-projection.ts'

const endpointId = 'remote:broker' as const
const agentWorkspace = {
  endpointId: 'remote:agent' as const,
  id: 'workspace-a', title: 'Agent', path: '/agent',
  sessions: [{ endpointId: 'remote:agent' as const, sessionId: 'shared', updatedAt: 2, running: true, blank: false, title: 'Agent title' }],
}

function api(options: {
  title?: string
  historyTitle?: string | null
  historyWithoutProjection?: boolean
  listError?: unknown
  historyError?: unknown
  fields?: boolean
} = {}) {
  return {
    sessions: {
      list: vi.fn(async () => {
        if (options.listError !== undefined) return { result: { ok: false as const, error: options.listError } } as never
        return { result: { ok: true as const, value: { items: [
          { endpointId, sessionId: 'local-title', updatedAt: 1, running: false, blank: false, projections: { values: { title: options.title ?? 'Local title' } } },
          {
            endpointId, sessionId: 'local-history', updatedAt: 2, running: false, blank: false,
            ...(options.fields ? { cwd: '/workspace', agentPreset: 'coding', parentSessionId: 'parent', origin: 'fork' } : {}),
          },
        ] } } } as never
      }),
      history: vi.fn(async () => {
        if (options.historyError !== undefined) return { result: { ok: false as const, error: options.historyError } } as never
        return { result: { ok: true as const, value: options.historyWithoutProjection ? {} : { projections: { values: { title: options.historyTitle === undefined ? 'History title' : options.historyTitle } } } } } as never
      }),
    },
  }
}

describe('Hub workspace projection', () => {
  it('projects local summaries, resolved history titles, and Agent summaries without changing ownership', async () => {
    const hostApi = api()
    await expect(projectWorkspaces({
      endpointId,
      registry: {
        list: () => [{ id: 'workspace-local', title: 'Local', path: '/local', sessionIds: ['local-title', 'local-history', 'missing'] as never }],
        archivedSessionIds: [],
      },
      api: hostApi,
      agentWorkspaces: [agentWorkspace],
      createRpcId: () => 'rpc',
    })).resolves.toEqual({
      endpointId,
      workspaces: [
        {
          endpointId, id: 'workspace-local', title: 'Local', path: '/local',
          sessions: [
            expect.objectContaining({ endpointId, sessionId: 'local-title', title: 'Local title' }),
            expect.objectContaining({ endpointId, sessionId: 'local-history', title: 'History title' }),
          ],
        },
        agentWorkspace,
      ],
    })
    expect(hostApi.sessions.history).toHaveBeenCalledTimes(1)
  })

  it('filters only selected endpoint-qualified workspaces and archived local sessions', async () => {
    await expect(projectWorkspaces({
      endpointId,
      registry: {
        list: () => [{ id: 'workspace-local', title: 'Local', path: '/local', sessionIds: ['local-title', 'local-history'] as never }],
        archivedSessionIds: ['local-history' as never],
      },
      api: api(),
      agentWorkspaces: [agentWorkspace],
      selected: [{ endpointId: 'remote:agent', workspaceId: 'workspace-a' }],
      createRpcId: () => 'rpc',
    })).resolves.toEqual({ endpointId, workspaces: [agentWorkspace] })
  })

  it('returns empty directories without a local registry or official API', async () => {
    await expect(projectWorkspaces({ endpointId, agentWorkspaces: [], createRpcId: () => 'rpc' }))
      .resolves.toEqual({ endpointId, workspaces: [] })
  })

  it('keeps summaries when history cannot resolve a title and rejects a failed official listing', async () => {
    const historyFailure = api({ historyError: { code: 'unavailable' } })
    const result = await projectWorkspaces({
      endpointId,
      registry: { list: () => [{ id: 'workspace-local', title: 'Local', path: '/local', sessionIds: ['local-history'] as never }], archivedSessionIds: [] },
      api: historyFailure, agentWorkspaces: [], createRpcId: () => 'rpc',
    })
    expect(result.workspaces[0]?.sessions[0]).not.toHaveProperty('title')
    await expect(projectWorkspaces({ endpointId, api: api({ listError: { code: 'failed' } }), agentWorkspaces: [], createRpcId: () => 'rpc' }))
      .rejects.toThrow('remote session listing failed')
  })

  it('preserves an untitled summary and all official metadata', async () => {
    await expect(projectWorkspaces({
      endpointId,
      registry: {
        list: () => [{ id: 'workspace-local', title: 'Local', path: '/local', sessionIds: ['local-history'] as never }],
        archivedSessionIds: [],
      },
      api: api({ historyTitle: '', fields: true }),
      agentWorkspaces: [],
      createRpcId: () => 'rpc',
    })).resolves.toMatchObject({
      workspaces: [{ sessions: [{ sessionId: 'local-history', cwd: '/workspace', agentPreset: 'coding', parentSessionId: 'parent', origin: 'fork' }] }],
    })
  })

  it('preserves a summary when history has no projection data', async () => {
    await expect(projectWorkspaces({
      endpointId,
      registry: { list: () => [{ id: 'workspace-local', title: 'Local', path: '/local', sessionIds: ['local-history'] as never }], archivedSessionIds: [] },
      api: api({ historyWithoutProjection: true }),
      agentWorkspaces: [],
      createRpcId: () => 'rpc',
    })).resolves.toMatchObject({ workspaces: [{ sessions: [{ sessionId: 'local-history' }] }] })
  })

  it('filters archived agent sessions without rewriting the remaining remote summary', async () => {
    const archivedAgent = {
      ...agentWorkspace,
      sessions: [
        ...agentWorkspace.sessions,
        { endpointId: 'remote:agent' as const, sessionId: 'archived', updatedAt: 3, running: false, blank: false, title: 'Archived' },
      ],
    }
    await expect(projectWorkspaces({
      endpointId,
      registry: { list: () => [], archivedSessionIds: ['archived' as never] },
      agentWorkspaces: [archivedAgent],
      createRpcId: () => 'rpc',
    })).resolves.toMatchObject({ workspaces: [{ sessions: [agentWorkspace.sessions[0]] }] })
  })
})

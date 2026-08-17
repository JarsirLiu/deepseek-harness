/** Three-process Endpoint Agent fixture for Hub registration and discovery. */

import { HubEndpointAgent, HubWorkspaceDirectoryProvider } from '../../src/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

const port = process.argv[2]
if (port === undefined) throw new Error('Hub Agent fixture requires a port')
const endpointId = (process.argv[3] ?? 'remote:registered-agent') as `remote:${string}`
const workspaceIds = (process.argv[4] ?? 'workspace-agent').split(',').filter(id => id !== '')
const nextWorkspaceId = process.argv[5]
if (workspaceIds.length === 0) throw new Error('Hub Agent fixture requires at least one workspace')

const workspaceDirectory = workspaceIds.map(workspaceId => ({
  workspaceId,
  title: `${endpointId} ${workspaceId}`,
  path: `D:/agent/${workspaceId}`,
  sessionIds: ['shared-session' as SessionId],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}))
const apiProxy = {
  events: {
    host: async function* (_request: unknown, signal: AbortSignal) {
      if (nextWorkspaceId !== undefined) {
        await new Promise<void>((resolve) => { publishWorkspaceChange = resolve })
        yield { payload: { type: 'host/workspace-changed', workspace: { workspaceId: nextWorkspaceId } } }
      }
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    },
  },
  sessions: {
    list: async (_request: unknown) => ({
      rpcId: 'hub-agent-session-list',
      result: { ok: true as const, value: { items: [{
        sessionId: 'shared-session' as SessionId, updatedAt: 1, running: false, blank: false,
      }] } },
    }),
    history: async (request: unknown) => ({ ok: true, value: { request, source: endpointId } }),
  },
  workspace: {
    list: async (_request: unknown) => ({
      rpcId: 'hub-agent-workspace-list',
      result: { ok: true as const, value: { items: workspaceDirectory, archivedSessionIds: [] } },
    }),
  },
}
let publishWorkspaceChange: (() => void) | undefined
const agent = new HubEndpointAgent({
  uri: `ws://127.0.0.1:${port}/hub`,
  endpointId,
  token: 'agent-secret',
  serverInfo: { name: 'registered-agent', version: '0.1.0' },
  apiProxy: apiProxy as never,
  directory: new HubWorkspaceDirectoryProvider(apiProxy as never),
})

await agent.connect()
console.log(JSON.stringify({ type: 'ready', endpointId: agent.registrationResult?.endpointId ?? null }))
if (nextWorkspaceId !== undefined) {
  workspaceDirectory.push({
    workspaceId: nextWorkspaceId,
    title: `${endpointId} ${nextWorkspaceId}`,
    path: `D:/agent/${nextWorkspaceId}`,
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  publishWorkspaceChange?.()
  console.log(JSON.stringify({ type: 'directory-updated', workspaceId: nextWorkspaceId }))
}

process.on('SIGTERM', () => {
  void agent.disconnect().then(() => { process.exit(0) })
})
process.stdin.resume()

import { describe, expect, it, vi } from 'vitest'
import { forwardApiRequest, type ApiForwardingDependencies } from '../src/api-forwarding.ts'

const base = (): ApiForwardingDependencies => ({
  endpointId: 'remote:hub',
  localWorkspaceIds: ['workspace-a'],
  localApi: { sessions: { list: vi.fn(async () => ({ result: { ok: true } })) } },
  agents: [],
  createRpcId: () => 'rpc' as never,
})

const request = (overrides: Record<string, unknown> = {}) => ({
  endpointId: 'remote:hub', workspaceId: 'workspace-a', method: 'session.list', payload: {}, ...overrides,
}) as never

describe('Hub API forwarding', () => {
  it('forwards an endpoint request through the matching Agent', async () => {
    const dependencies = base()
    const agent = { endpointId: 'remote:agent' as const, workspaces: [{ endpointId: 'remote:agent' as const, id: 'workspace-a', title: 'A', path: '/a', sessions: [] }], request: vi.fn(async () => ({ source: 'agent' })) }
    dependencies.agents = [agent]
    await expect(forwardApiRequest(request({ endpointId: 'remote:agent' }), dependencies)).resolves.toEqual({ source: 'agent' })
    expect(agent.request).toHaveBeenCalledWith('hub/api/request', expect.anything())
  })

  it('rejects unavailable endpoint and workspace before forwarding', async () => {
    await expect(forwardApiRequest(request({ endpointId: 'remote:missing' }), base())).rejects.toThrow('remote endpoint unavailable')
    const dependencies = base()
    dependencies.agents = [{ endpointId: 'remote:agent', workspaces: [], request: vi.fn() }]
    await expect(forwardApiRequest(request({ endpointId: 'remote:agent' }), dependencies)).rejects.toThrow('remote workspace unavailable')
  })

  it('rejects unsupported and unavailable local methods', async () => {
    await expect(forwardApiRequest(request({ method: 'session.unknown' }), base())).rejects.toThrow('unsupported remote API method')
    await expect(forwardApiRequest(request({ method: 'session.history' }), base())).rejects.toThrow('remote API method is unavailable')
    await expect(forwardApiRequest(request({ workspaceId: 'missing' }), base())).rejects.toThrow('local workspace unavailable')
  })

  it('maps subagent and workspace domains to their official API names', async () => {
    const dependencies = base()
    const subagent = vi.fn(async () => ({ result: 'subagent' }))
    const workspace = vi.fn(async () => ({ result: 'workspace' }))
    dependencies.localApi = { subagents: { list: subagent }, workspace: { rename: workspace } }
    await expect(forwardApiRequest(request({ method: 'subagent.list' }), dependencies)).resolves.toBe('subagent')
    await expect(forwardApiRequest(request({ method: 'workspace.rename' }), dependencies)).resolves.toBe('workspace')
  })
})

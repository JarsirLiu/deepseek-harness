import { describe, expect, it } from 'vitest'
import {
  parseAgentEventNotification,
  parseAgentHostEventParams,
  parseAgentRegisterParams,
  parseApiRequestParams,
  parseWorkspacePublishParams,
  parseWorkspaceSubscriptionParams,
  parseWorkspaces,
  requireEndpointId,
} from '../src/wire-params.ts'

const session = { endpointId: 'remote:agent', sessionId: 'session-a', updatedAt: 1, running: false, blank: false }
const workspace = { endpointId: 'remote:agent', id: 'workspace-a', title: 'A', path: '/a', sessions: [session] }

describe('Hub wire parameters', () => {
  it('parses valid endpoint, API, Agent, workspace, and event payloads', () => {
    expect(requireEndpointId('remote:agent')).toBe('remote:agent')
    expect(parseApiRequestParams({ endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'session.history', payload: { sessionId: 'session-a' } }))
      .toEqual({ endpointId: 'remote:agent', workspaceId: 'workspace-a', method: 'session.history', payload: { sessionId: 'session-a' } })
    expect(parseAgentRegisterParams({ endpointId: 'remote:agent', token: 'token', version: '1', serverInfo: { name: 'Agent', version: '1' }, workspaces: [workspace] }))
      .toMatchObject({ endpointId: 'remote:agent', token: 'token', version: '1', workspaces: [workspace] })
    expect(parseAgentRegisterParams({ endpointId: 'remote:agent', token: 'token', serverInfo: { name: 'Agent', version: '1' }, workspaces: [] }))
      .not.toHaveProperty('version')
    expect(parseWorkspacePublishParams({ workspaces: [workspace] })).toEqual({ workspaces: [workspace] })
    expect(parseWorkspaceSubscriptionParams({})).toEqual({})
    expect(parseWorkspaceSubscriptionParams({ workspaces: [{ endpointId: 'remote:agent', workspaceId: 'workspace-a' }] }))
      .toEqual({ workspaces: [{ endpointId: 'remote:agent', workspaceId: 'workspace-a' }] })
    expect(parseAgentHostEventParams({ endpointId: 'remote:agent', workspaceId: null, frame: { type: 'host/ready' } }))
      .toMatchObject({ endpointId: 'remote:agent', workspaceId: null })
    expect(parseAgentEventNotification({ endpointId: 'remote:agent', workspaceId: 'workspace-a', sessionId: 'session-a', event: { type: 'assistant/chunk' } }))
      .toMatchObject({ endpointId: 'remote:agent', workspaceId: 'workspace-a', sessionId: 'session-a' })
  })

  it('rejects invalid endpoint and API fields', () => {
    for (const endpointId of ['', 'agent', 'remote:with space', 1, null]) {
      expect(() => requireEndpointId(endpointId as `remote:${string}`)).toThrow('invalid Hub endpoint identity')
    }
    for (const params of [
      {},
      { endpointId: 'agent', workspaceId: 'w', method: 'm', payload: {} },
      { endpointId: 'remote:a', workspaceId: '', method: 'm', payload: {} },
      { endpointId: 'remote:a', workspaceId: 'w', method: '', payload: {} },
      { endpointId: 'remote:a', workspaceId: 'w', method: 'm', payload: [] },
    ]) expect(() => parseApiRequestParams(params)).toThrow('invalid Hub API request')
  })

  it('rejects invalid Agent registration and workspace directories', () => {
    for (const params of [
      {},
      { endpointId: 'agent', token: 't', serverInfo: { name: 'n', version: 'v' }, workspaces: [] },
      { endpointId: 'remote:a', token: '', serverInfo: { name: 'n', version: 'v' }, workspaces: [] },
      { endpointId: 'remote:a', token: 't', serverInfo: { name: '', version: 'v' }, workspaces: [] },
      { endpointId: 'remote:a', token: 't', serverInfo: { name: 'n', version: '' }, workspaces: [] },
      { endpointId: 'remote:a', token: 't', version: 1, serverInfo: { name: 'n', version: 'v' }, workspaces: [] },
    ]) expect(() => parseAgentRegisterParams(params)).toThrow('invalid Endpoint Agent registration')
    for (const value of [
      {}, [null], [{ endpointId: 'agent', id: 'w', title: 'W', path: '/w', sessions: [] }],
      [{ endpointId: 'remote:a', id: '', title: 'W', path: '/w', sessions: [] }],
      [{ endpointId: 'remote:a', id: 'w', title: 1, path: '/w', sessions: [] }],
      [{ endpointId: 'remote:a', id: 'w', title: 'W', path: 1, sessions: [] }],
      [{ endpointId: 'remote:a', id: 'w', title: 'W', path: '/w', sessions: {} }],
      [{ endpointId: 'remote:a', id: 'w', title: 'W', path: '/w', sessions: [{ endpointId: 'remote:a', sessionId: '', updatedAt: 1, running: false, blank: false }] }],
      [{ endpointId: 'remote:a', id: 'w', title: 'W', path: '/w', sessions: [{ endpointId: 'remote:a', sessionId: 's', updatedAt: Infinity, running: false, blank: false }] }],
      [{ endpointId: 'remote:a', id: 'w', title: 'W', path: '/w', sessions: [{ endpointId: 'remote:a', sessionId: 's', updatedAt: 1, running: 'false', blank: false }] }],
      [{ endpointId: 'remote:a', id: 'w', title: 'W', path: '/w', sessions: [{ endpointId: 'remote:a', sessionId: 's', updatedAt: 1, running: false, blank: 'false' }] }],
    ]) expect(() => parseWorkspaces(value)).toThrow('invalid Endpoint Agent workspace directory')
  })

  it('rejects invalid workspace subscriptions and Agent event notifications', () => {
    for (const params of [{ workspaces: {} }, { workspaces: [{}] }, { workspaces: [{ endpointId: 'agent', workspaceId: 'w' }] }, { workspaces: [{ endpointId: 'remote:a', workspaceId: '' }] }]) {
      expect(() => parseWorkspaceSubscriptionParams(params)).toThrow('invalid Hub workspace subscription')
    }
    for (const params of [{}, { endpointId: 'agent', workspaceId: null, frame: { type: 'x' } }, { endpointId: 'remote:a', workspaceId: '', frame: { type: 'x' } }, { endpointId: 'remote:a', workspaceId: null, frame: {} }, { endpointId: 'remote:a', workspaceId: null, frame: { type: 1 } }]) {
      expect(() => parseAgentHostEventParams(params)).toThrow('invalid Endpoint Agent Host event')
    }
    for (const params of [{}, { endpointId: 'agent', workspaceId: 'w', sessionId: 's', event: { type: 'x' } }, { endpointId: 'remote:a', workspaceId: '', sessionId: 's', event: { type: 'x' } }, { endpointId: 'remote:a', workspaceId: 'w', sessionId: '', event: { type: 'x' } }, { endpointId: 'remote:a', workspaceId: 'w', sessionId: 's', event: {} }, { endpointId: 'remote:a', workspaceId: 'w', sessionId: 's', event: { type: 1 } }]) {
      expect(() => parseAgentEventNotification(params)).toThrow('invalid Endpoint Agent session event')
    }
  })
})

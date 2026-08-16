import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createRemoteSessionTransport, RemoteSessionTransportRegistry, resolveRemoteSessionTransport } from '../src/index.ts'

describe('Hub Web adapter endpoint ownership', () => {
  it('does not let one endpoint claim another endpoint session', () => {
    const first = createRemoteSessionTransport('remote:first')
    const second = createRemoteSessionTransport('remote:second')
    const ref = { endpointId: 'remote:second' as const, sessionId: 'same-session' as SessionId }

    expect(first.owns(ref)).toBe(false)
    expect(second.owns(ref)).toBe(true)
    expect(() => resolveRemoteSessionTransport(first, ref)).toThrow(/remote endpoint unavailable/)
    expect(resolveRemoteSessionTransport(second, ref)).toBe(second)
  })

  it('does not route local sessions through the remote adapter', () => {
    const transport = createRemoteSessionTransport('remote:first')

    expect(resolveRemoteSessionTransport(transport, {
      endpointId: 'local:default',
      sessionId: 'same-session' as SessionId,
    })).toBeUndefined()
  })

  it('keeps multiple endpoint transports independently addressable', () => {
    const registry = new RemoteSessionTransportRegistry()
    const first = createRemoteSessionTransport('remote:first')
    const second = createRemoteSessionTransport('remote:second')
    const disposeFirst = registry.register(first)
    registry.register(second)

    expect(registry.endpoints()).toEqual(['remote:first', 'remote:second'])
    expect(registry.resolve({ endpointId: 'remote:second', sessionId: 'same-session' as SessionId })).toBe(second)
    disposeFirst()
    expect(registry.endpoints()).toEqual(['remote:second'])
    expect(() => registry.resolve({ endpointId: 'remote:first', sessionId: 'same-session' as SessionId })).toThrow(/remote endpoint unavailable/)
  })

  it('rejects local references at the remote registry', () => {
    const registry = new RemoteSessionTransportRegistry()
    registry.register(createRemoteSessionTransport('remote:first'))

    expect(() => registry.resolve({ endpointId: 'local:default', sessionId: 'same-session' as SessionId })).toThrow(/local session cannot use/)
  })

  it('preserves the official history view and projection baseline', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      events: [{ event: { seq: 1, type: 'tool/result', data: {} }, view: { for: 'tool', card: 'chart' } }],
      hasMore: true,
      projections: { asOfSeq: 1, values: { permissions: { currentValue: 'workspace-write', options: [] } } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      const result = await createRemoteSessionTransport('remote:first').history('session-1' as SessionId, { maxMessages: 5 })
      expect(result).toMatchObject({
        ok: true,
        value: {
          events: [{ view: { for: 'tool', card: 'chart' } }],
          hasMore: true,
          projections: { asOfSeq: 1, values: { permissions: { currentValue: 'workspace-write' } } },
        },
      })
      expect(fetch.mock.calls[0]?.[0]).toBe('/api/hub/rpc')
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
      expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
        method: 'hub/session/history',
        params: { id: 'session-1', maxMessages: 5 },
      })
    } finally {
      fetch.mockRestore()
    }
  })
})

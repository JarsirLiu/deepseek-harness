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
      result: { ok: true, value: {
        events: [{ event: { seq: 1, type: 'tool/result', data: {} }, view: { for: 'tool', card: 'chart' } }],
        hasMore: true,
        projections: { asOfSeq: 1, values: { permissions: { currentValue: 'workspace-write', options: [] } } },
      } },
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
        method: 'hub/api/request',
        params: { method: 'session.history', payload: { sessionId: 'session-1', maxMessages: 5 } },
      })
    } finally {
      fetch.mockRestore()
    }
  })

  it('returns the official model catalog without the Hub response wrapper', async () => {
    const catalog = {
      current: { provider: 'remote-provider', model: 'remote-model' },
      routable: true,
      groups: [{ id: 'remote-provider', name: 'Remote', models: [{ id: 'remote-model', name: 'Remote model' }] }],
      failures: [],
    }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      result: { ok: true, value: catalog },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      await expect(createRemoteSessionTransport('remote:first').models('session-1' as SessionId))
        .resolves.toEqual({ ok: true, value: catalog })
    } finally {
      fetch.mockRestore()
    }
  })

  it('returns the official model selection result without the Hub response wrapper', async () => {
    const selected = { provider: 'remote-provider', model: 'remote-model', reasoningEffort: 'high' }
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      result: { ok: true, value: { selected } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      await expect(createRemoteSessionTransport('remote:first').selectModel('session-1' as SessionId, selected))
        .resolves.toEqual({ ok: true, value: { selected } })
    } finally {
      fetch.mockRestore()
    }
  })

  it('reports a malformed Hub response as a transport error', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    try {
      await expect(createRemoteSessionTransport('remote:first').models('session-1' as SessionId))
        .resolves.toMatchObject({ ok: false, error: { code: 'internal', message: 'Hub API response is missing result' } })
    } finally {
      fetch.mockRestore()
    }
  })

  it.each([
    ['prompt', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.prompt('session-1' as SessionId, [{ type: 'text', text: 'hello' }], 'queue')],
    ['cancel', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.cancel('session-1' as SessionId)],
    ['rename', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.rename('session-1' as SessionId, 'Renamed')],
    ['updateQueue', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.updateQueue('session-1' as SessionId, 'message-1' as never, { kind: 'remove' })],
    ['fork', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.fork('session-1' as SessionId, 3)],
    ['subagentList', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.subagentList('session-1' as SessionId)],
  ])('unwraps the official RpcResult for %s', async (_name, invoke) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      result: { ok: true, value: { accepted: true } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      await expect(invoke(createRemoteSessionTransport('remote:first')))
        .resolves.toEqual({ ok: true, value: { accepted: true } })
    } finally {
      fetch.mockRestore()
    }
  })

  it('normalizes HTTP failures to the same RpcResult error format', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }))
    try {
      await expect(createRemoteSessionTransport('remote:first').prompt('session-1' as SessionId, [], 'queue'))
        .resolves.toMatchObject({ ok: false, error: { code: 'internal', message: 'HTTP 502' } })
    } finally {
      fetch.mockRestore()
    }
  })
})

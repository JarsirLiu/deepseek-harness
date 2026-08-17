import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createRemoteSessionTransport, parseQualifiedSessionId, qualifiedSessionId, RemoteSessionTransportRegistry, resolveRemoteSessionTransport, SessionEndpointRegistry, sessionKey } from '../src/index.ts'

type HubRequest = {
  method: string
  params: { method: string; payload?: unknown }
}

function requestBody(init: RequestInit | undefined): HubRequest {
  if (typeof init?.body !== 'string') throw new Error('expected a serialized Hub request')
  return JSON.parse(init.body) as HubRequest
}

describe('Hub Web adapter endpoint ownership', () => {
  it('encodes and parses endpoint-qualified session references', () => {
    const ref = { endpointId: 'remote:first' as const, sessionId: 'same-session' as SessionId }
    expect(sessionKey(ref)).toBe('remote:first|same-session')
    expect(qualifiedSessionId(ref)).toBe('remote:first|same-session')
    expect(parseQualifiedSessionId(qualifiedSessionId(ref))).toEqual(ref)
    expect(parseQualifiedSessionId('same-session' as SessionId)).toBeUndefined()
    expect(parseQualifiedSessionId('local:default|same-session' as SessionId)).toBeUndefined()
    expect(parseQualifiedSessionId('remote:first|' as SessionId)).toEqual({ endpointId: 'remote:first', sessionId: '' })
  })

  it('detects ambiguous bare session ownership and removes all matches', () => {
    const registry = new SessionEndpointRegistry()
    const sessionId = 'same-session' as SessionId
    registry.bind({ endpointId: 'remote:first', sessionId })
    expect(registry.resolve({ endpointId: 'remote:first', sessionId })).toBe('remote:first')
    expect(registry.endpointFor(sessionId)).toBe('remote:first')
    registry.bind({ endpointId: 'remote:second', sessionId })
    expect(() => registry.endpointFor(sessionId)).toThrow(/multiple endpoints/)
    registry.remove(sessionId)
    expect(registry.resolve({ endpointId: 'remote:first', sessionId })).toBeUndefined()
    expect(registry.endpointFor(sessionId)).toBeUndefined()
  })

  it('ignores unrelated bindings when resolving or removing a bare id', () => {
    const registry = new SessionEndpointRegistry()
    registry.bind({ endpointId: 'remote:first', sessionId: 'other-session' as SessionId })
    registry.bind({ endpointId: 'remote:second', sessionId: 'same-session' as SessionId })
    expect(registry.endpointFor('missing-session' as SessionId)).toBeUndefined()
    registry.remove('missing-session' as SessionId)
    expect(registry.endpointFor('same-session' as SessionId)).toBe('remote:second')
  })

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

  it('rejects duplicate endpoints and exposes registered transports', () => {
    const registry = new RemoteSessionTransportRegistry()
    const transport = createRemoteSessionTransport('remote:first')
    const dispose = registry.register(transport)
    expect(registry.get('remote:first')).toBe(transport)
    expect(registry.get('remote:missing')).toBeUndefined()
    expect(() => registry.register(transport)).toThrow(/already registered/)
    dispose()
    dispose()
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
      const result = await createRemoteSessionTransport('remote:first').history('workspace-a', 'session-1' as SessionId, { maxMessages: 5 })
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
      expect(requestBody(fetch.mock.calls[0]?.[1] as RequestInit)).toEqual({
        method: 'hub/api/request',
        params: { endpointId: 'remote:first', workspaceId: 'workspace-a', method: 'session.history', payload: { sessionId: 'session-1', maxMessages: 5 } },
      })
    } finally {
      fetch.mockRestore()
    }
  })

  it('preserves history without inventing an empty projection block', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      result: { ok: true, value: { events: [], hasMore: false } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      await expect(createRemoteSessionTransport('remote:first').history('workspace-a', 'session-1' as SessionId, {}))
        .resolves.toEqual({ ok: true, value: { events: [], hasMore: false } })
    } finally {
      fetch.mockRestore()
    }
  })

  it('returns history transport errors without rewriting them', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 400 }))
    try {
      await expect(createRemoteSessionTransport('remote:first').history('workspace-a', 'session-1' as SessionId, {}))
        .resolves.toMatchObject({ ok: false, error: { message: 'HTTP 400' } })
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
      await expect(createRemoteSessionTransport('remote:first').models('workspace-a', 'session-1' as SessionId))
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
      await expect(createRemoteSessionTransport('remote:first').selectModel('workspace-a', 'session-1' as SessionId, selected))
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
      await expect(createRemoteSessionTransport('remote:first').models('workspace-a', 'session-1' as SessionId))
        .resolves.toMatchObject({ ok: false, error: { code: 'internal', message: 'Hub API response is missing result' } })
    } finally {
      fetch.mockRestore()
    }
  })

  it.each([
    ['prompt', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.prompt('workspace-a', 'session-1' as SessionId, [{ type: 'text', text: 'hello' }], 'queue')],
    ['cancel', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.cancel('workspace-a', 'session-1' as SessionId)],
    ['rename', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.rename('workspace-a', 'session-1' as SessionId, 'Renamed')],
    ['updateQueue', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.updateQueue('workspace-a', 'session-1' as SessionId, 'message-1' as never, { kind: 'remove' })],
    ['fork', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.fork('workspace-a', 'session-1' as SessionId, 3)],
    ['subagentList', (transport: ReturnType<typeof createRemoteSessionTransport>) => transport.subagentList('workspace-a', 'session-1' as SessionId)],
  ])('unwraps the official RpcResult for %s', async (_name, invoke) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
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
      await expect(createRemoteSessionTransport('remote:first').prompt('workspace-a', 'session-1' as SessionId, [], 'queue'))
        .resolves.toMatchObject({ ok: false, error: { code: 'internal', message: 'HTTP 502' } })
    } finally {
      fetch.mockRestore()
    }
  })

  it('forwards every session and subagent operation through the same API method', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      result: { ok: true, value: { accepted: true } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const transport = createRemoteSessionTransport('remote:first')
    const address = { parentSessionId: 'parent' as SessionId, childSessionId: 'child' as SessionId, mode: 'continuable' as const }
    try {
      await transport.readAttachment('workspace-a', 'session-1' as SessionId, 'attachment-1' as never)
      await transport.archiveSession('workspace-a', 'session-1' as SessionId)
      await transport.subagentHistory('workspace-a', address, { maxMessages: 4 })
      await transport.subagentPrompt('workspace-a', address, [{ type: 'text', text: 'hello' }])
      await transport.subagentInterrupt('workspace-a', address)
      const methods = fetch.mock.calls.map(call => requestBody(call[1] as RequestInit).params.method)
      expect(methods).toEqual([
        'session.attachment', 'workspace.archiveSession', 'subagent.history',
        'subagent.prompt', 'subagent.interrupt',
      ])
      for (const call of fetch.mock.calls) {
        expect(requestBody(call[1] as RequestInit).params).toMatchObject({
          endpointId: 'remote:first',
          workspaceId: 'workspace-a',
        })
      }
    } finally {
      fetch.mockRestore()
    }
  })

  it('shares and reconnects the mux EventSource, and forwards host frames', () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = []
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      close = vi.fn()
      constructor(readonly url: string) { FakeEventSource.instances.push(this) }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const transport = createRemoteSessionTransport('remote:first')
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = transport.subscribe('session-1' as SessionId, first)
    const disposeSecond = transport.subscribe('session-1' as SessionId, second)
    const source = FakeEventSource.instances[0]!
    source.onmessage?.({ data: JSON.stringify({ endpointId: 'remote:first', sessionId: 'other', event: {} }) } as MessageEvent)
    source.onmessage?.({ data: JSON.stringify({ endpointId: 'remote:first', sessionId: 'session-1', event: { seq: 1 } }) } as MessageEvent)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    disposeFirst()
    source.onerror?.()
    const reconnected = FakeEventSource.instances.at(-1)!
    expect(reconnected).not.toBe(source)
    const host = vi.fn()
    const disposeHost = transport.subscribeHost(host)
    const hostSource = FakeEventSource.instances.at(-1)!
    hostSource.onmessage?.({ data: JSON.stringify({ frame: { type: 'host/session-status' } }) } as MessageEvent)
    expect(host).toHaveBeenCalledWith({ type: 'host/session-status' })
    disposeHost()
    disposeSecond()
    expect(reconnected.close).toHaveBeenCalled()
    reconnected.onerror?.()
    vi.unstubAllGlobals()
  })

  it('requires remote endpoint identities and follows dynamic endpoint ownership', () => {
    expect(() => createRemoteSessionTransport('local:default')).toThrow(/requires a remote endpoint/)
    let endpoint: 'remote:first' | 'remote:second' = 'remote:first'
    const transport = createRemoteSessionTransport(() => endpoint)
    expect(transport.endpointId).toBe('remote:first')
    expect(transport.owns({ endpointId: 'remote:first', sessionId: 'session-1' as SessionId })).toBe(true)
    endpoint = 'remote:second'
    expect(transport.endpointId).toBe('remote:second')
    expect(transport.owns({ endpointId: 'remote:first', sessionId: 'session-1' as SessionId })).toBe(false)
  })

  it('omits an undefined fork sequence from the forwarded payload', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      result: { ok: true, value: { sessionId: 'forked' } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      await createRemoteSessionTransport('remote:first').fork('workspace-a', 'session-1' as SessionId)
      expect(requestBody(fetch.mock.calls[0]?.[1] as RequestInit).params.payload)
        .toEqual({ sessionId: 'session-1' })
    } finally {
      fetch.mockRestore()
    }
  })
})

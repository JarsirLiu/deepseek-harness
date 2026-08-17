import { describe, expect, it } from 'vitest'
import { HubServer } from '../src/server.ts'

describe('Hub endpoint identity', () => {
  it('rejects an identity that is not an explicit remote endpoint id', () => {
    expect(() => new HubServer({} as never, {
      endpointId: 'configured-client-id' as `remote:${string}`,
    })).toThrow('invalid Hub endpoint identity')
  })

  it('requires an explicit agent token for endpoint registration', async () => {
    const server = new HubServer({} as never, {
      endpointId: 'remote:broker',
      agentTokens: { 'remote:agent': 'secret' },
    })
    const client = {
      authenticated: false,
      role: 'client' as const,
      endpointId: undefined,
    }
    const register = (server as unknown as {
      handleAgentRegister: (client: typeof client, params: unknown) => unknown
    }).handleAgentRegister.bind(server)
    await expect(Promise.resolve().then(() => register(client, {
      endpointId: 'remote:agent', token: 'wrong', serverInfo: { name: 'agent', version: '1' }, workspaces: [],
    }))).rejects.toThrow('endpoint authentication failed')
  })
})

import { describe, expect, it } from 'vitest'
import { HubServer } from '../src/server.ts'

describe('Hub endpoint identity', () => {
  it('rejects an identity that is not an explicit remote endpoint id', () => {
    expect(() => new HubServer({} as never, {
      endpointId: 'configured-client-id' as `remote:${string}`,
    })).toThrow('invalid Hub endpoint identity')
  })
})

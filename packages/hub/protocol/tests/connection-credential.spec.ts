import { describe, expect, it } from 'vitest'
import { decodeHubConnectionCredential, encodeHubConnectionCredential } from '../src/connection-credential.ts'

const value = { version: 1 as const, uri: 'ws://hub.example/hub', endpointId: 'remote:hub-1' as const, serverName: 'Hub', token: 'secret' }

describe('Hub connection credentials', () => {
  it('round trips a reusable credential', () => {
    const encoded = encodeHubConnectionCredential(value)
    expect(encoded.startsWith('dshhub:v1:')).toBe(true)
    expect(decodeHubConnectionCredential(encoded)).toEqual(value)
  })

  it('rejects malformed, unsupported, and incomplete credentials', () => {
    expect(() => decodeHubConnectionCredential('plain')).toThrow(/prefix/)
    expect(() => decodeHubConnectionCredential('dshhub:v1:not-json')).toThrow(/payload/)
    const bad = Buffer.from(JSON.stringify({ ...value, version: 2 })).toString('base64url')
    expect(() => decodeHubConnectionCredential(`dshhub:v1:${bad}`)).toThrow(/fields/)
    expect(() => encodeHubConnectionCredential({ ...value, token: '' })).toThrow(/fields/)
  })
})

import { randomUUID } from 'node:crypto'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { encodeHubConnectionCredential } from '@deepseek-ai/dsh-hub-protocol'

export interface HubIdentitySettings {
  endpointId: `remote:${string}`
  serverName: string
  credentialRef: string
  credentialEnabled: boolean
}

/** Create a stable endpoint identity for a newly initialized Hub. */
export function createHubIdentity(serverName = 'deepseek-harness-hub'): HubIdentitySettings {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
  return {
    endpointId: `remote:${suffix}`,
    serverName,
    credentialRef: `DSH_HUB_TOKEN_${suffix.toUpperCase()}`,
    credentialEnabled: true,
  }
}

/** Persist or rotate the long-lived authentication token owned by a Hub. */
export async function ensureHubToken(credentials: CredentialProvider, identity: HubIdentitySettings): Promise<string> {
  const ref = credentialRef(identity.credentialRef)
  const existing = await credentials.resolve(ref)
  if (existing !== undefined) return existing.value
  const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
  await credentials.set(ref, token)
  return token
}

/** Build the reusable credential string shown by the Hub settings page. */
export function makeHubConnectionCredential(identity: HubIdentitySettings, token: string, uri: string): string {
  return encodeHubConnectionCredential({
    version: 1,
    uri,
    endpointId: identity.endpointId,
    serverName: identity.serverName,
    token,
  })
}

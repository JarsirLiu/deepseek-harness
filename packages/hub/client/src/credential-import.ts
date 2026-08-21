import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { decodeHubConnectionCredential } from '@deepseek-ai/dsh-hub-protocol'
import type { HubEndpointConfig, HubConnectionManager } from './connection-manager.ts'

/** Import a reusable Hub credential into the local endpoint registry. */
export async function importHubConnectionCredential(manager: HubConnectionManager, input: string): Promise<HubEndpointConfig> {
  const credential = decodeHubConnectionCredential(input.trim())
  const id = `hub-${credential.endpointId.slice('remote:'.length)}`
  const credentialRefName = credentialRef(`DSH_HUB_REMOTE_${credential.endpointId.slice('remote:'.length).replaceAll('-', '_').toUpperCase()}`)
  await manager.storeCredential(credentialRefName, credential.token)
  const config: HubEndpointConfig = {
    id,
    label: credential.serverName,
    uri: credential.uri,
    credentialRef: credentialRefName,
    enabled: true,
    registerAgent: true,
  }
  const existing = manager.list().find(entry => entry.id === id)
  if (existing === undefined) await manager.create(config)
  else await manager.update(id, config)
  return config
}

/** Versioned, reusable connection credential for a Hub endpoint. */

export interface HubConnectionCredential {
  version: 1
  uri: string
  endpointId: `remote:${string}`
  serverName: string
  token: string
}

const PREFIX = 'dshhub:v1:'

/** Encode a reusable Hub connection credential for transfer between nodes. */
export function encodeHubConnectionCredential(value: HubConnectionCredential): string {
  validate(value)
  const json = JSON.stringify(value)
  return `${PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`
}

/** Decode and validate a credential pasted into a Hub client. */
export function decodeHubConnectionCredential(input: string): HubConnectionCredential {
  if (!input.startsWith(PREFIX)) throw new TypeError('invalid Hub credential prefix')
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(input.slice(PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    throw new TypeError('invalid Hub credential payload')
  }
  validate(value)
  return value
}

function validate(value: unknown): asserts value is HubConnectionCredential {
  if (value === null || typeof value !== 'object') throw new TypeError('invalid Hub credential')
  const candidate = value as Record<string, unknown>
  if (candidate.version !== 1 || typeof candidate.uri !== 'string' || candidate.uri.length === 0 ||
      typeof candidate.endpointId !== 'string' || !candidate.endpointId.startsWith('remote:') ||
      typeof candidate.serverName !== 'string' || typeof candidate.token !== 'string' || candidate.token.length === 0) {
    throw new TypeError('invalid Hub credential fields')
  }
}

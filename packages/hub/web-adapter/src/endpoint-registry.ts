import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'

/** Stable identity of a Host that owns sessions. */
export type SessionEndpointId = `local:${string}` | `remote:${string}`

/** A session identity qualified by its owning endpoint workspace. */
export interface SessionRef {
  readonly endpointId: SessionEndpointId
  readonly workspaceId: string
  readonly sessionId: SessionId
}

/** Collision-free key for an endpoint-workspace-qualified session. */
export type SessionKey = `${SessionEndpointId}|${string}|${SessionId}`

/** Build the internal key for one endpoint-qualified session.
 * @param ref - the endpoint-qualified session reference.
 * @returns the collision-free registry key.
 */
export function sessionKey(ref: SessionRef): SessionKey {
  return `${ref.endpointId}|${encodeURIComponent(ref.workspaceId)}|${encodeURIComponent(ref.sessionId)}` as SessionKey
}

/** Encode a remote session reference for the Web Runtime's single-id UI APIs.
 * @param ref - the endpoint-qualified session reference.
 * @returns the encoded session id.
 */
export function qualifiedSessionId(ref: SessionRef): SessionId {
  return sessionKey(ref) as SessionId
}

/** Recover the endpoint-qualified reference from an encoded Runtime id.
 * @param id - the encoded session id.
 * @returns the decoded remote reference, or undefined for a local or malformed id.
 */
export function parseQualifiedSessionId(id: SessionId): SessionRef | undefined {
  const encoded = String(id)
  const firstSeparator = encoded.indexOf('|')
  const secondSeparator = encoded.indexOf('|', firstSeparator + 1)
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1) return undefined
  const endpointId = encoded.slice(0, firstSeparator)
  if (!endpointId.startsWith('remote:')) return undefined
  try {
    return {
      endpointId: endpointId as SessionEndpointId,
      workspaceId: decodeURIComponent(encoded.slice(firstSeparator + 1, secondSeparator)),
      sessionId: decodeURIComponent(encoded.slice(secondSeparator + 1)) as SessionId,
    }
  } catch {
    return undefined
  }
}

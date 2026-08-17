import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'

/** Stable identity of a Host that owns sessions. */
export type SessionEndpointId = `local:${string}` | `remote:${string}`

/** A session identity qualified by its owning endpoint. */
export interface SessionRef {
  readonly endpointId: SessionEndpointId
  readonly sessionId: SessionId
}

/** Collision-free key for an endpoint-qualified session. */
export type SessionKey = `${SessionEndpointId}|${SessionId}`

/** Build the internal key for one endpoint-qualified session.
 * @param ref - the endpoint-qualified session reference.
 * @returns the collision-free registry key.
 */
export function sessionKey(ref: SessionRef): SessionKey {
  return `${ref.endpointId}|${ref.sessionId}`
}

/** Encode a remote session reference for the Web Runtime's single-id UI APIs.
 * @param ref - the endpoint-qualified session reference.
 * @returns the encoded session id.
 */
export function qualifiedSessionId(ref: SessionRef): SessionId {
  return `${ref.endpointId}|${ref.sessionId}` as SessionId
}

/** Recover the endpoint-qualified reference from an encoded Runtime id.
 * @param id - the encoded session id.
 * @returns the decoded remote reference, or undefined for a local or malformed id.
 */
export function parseQualifiedSessionId(id: SessionId): SessionRef | undefined {
  const separator = String(id).indexOf('|')
  if (separator <= 0) return undefined
  const endpointId = String(id).slice(0, separator)
  if (!endpointId.startsWith('remote:')) return undefined
  return { endpointId: endpointId as SessionEndpointId, sessionId: String(id).slice(separator + 1) as SessionId }
}

/** Owns endpoint bindings shared by the Hub Web adapter consumers. */
export class SessionEndpointRegistry {
  private readonly owners = new Map<SessionKey, SessionEndpointId>()

  /** Bind one session to its endpoint.
   * @param ref - the endpoint-qualified session reference.
   */
  bind(ref: SessionRef): void {
    this.owners.set(sessionKey(ref), ref.endpointId)
  }

  /** Resolve an already-qualified session reference.
   * @param ref - the endpoint-qualified session reference.
   * @returns the owning endpoint, if registered.
   */
  resolve(ref: SessionRef): SessionEndpointId | undefined {
    return this.owners.get(sessionKey(ref))
  }

  /** Resolve a bare session id only when exactly one endpoint owns it.
   * @param sessionId - the unqualified session id.
   * @returns the sole owning endpoint, if one exists.
   */
  endpointFor(sessionId: SessionId): SessionEndpointId | undefined {
    let endpoint: SessionEndpointId | undefined
    for (const key of this.owners.keys()) {
      if (!key.endsWith(`|${sessionId}`)) continue
      const candidate = key.slice(0, key.indexOf('|')) as SessionEndpointId
      if (endpoint !== undefined && endpoint !== candidate) {
        throw new Error(`session id is owned by multiple endpoints: ${String(sessionId)}`)
      }
      endpoint = candidate
    }
    return endpoint
  }

  /** Remove all bindings for one bare session id.
   * @param sessionId - the unqualified session id to remove.
   */
  remove(sessionId: SessionId): void {
    for (const key of this.owners.keys()) {
      if (key.endsWith(`|${sessionId}`)) this.owners.delete(key)
    }
  }
}

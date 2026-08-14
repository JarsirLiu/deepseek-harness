/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-hub-server`.
 * @module @deepseek-ai/dsh-hub-server/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-hub-server'

/** Cordis companion plugin name. */
export const name = 'hub-server-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the hub server is a network listener that bridges
 * WebSocket JSON-RPC to the local SessionStore and SessionPersistence. The
 * session data it touches is owned by those services, not this package.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-hub-client`.
 * @module @deepseek-ai/dsh-hub-client/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-hub-client'

/** Cordis companion plugin name. */
export const name = 'hub-client-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the remote session provider is a network proxy that
 * delegates session operations to a remote hub server. The session data it
 * touches is owned by the remote hub, not this package.
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

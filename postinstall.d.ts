/**
 * Types for `postinstall.js`. // implements XSPEC-365 R7
 *
 * The hook is plain JavaScript for the same reason `preinstall.js` is — it
 * runs against the published package, where nothing of this repo's TypeScript
 * exists. These declarations let `test/postinstall.test.ts` assert both the
 * notice text and, more importantly, the condition that decides whether it is
 * shown at all.
 */

/** The post-install notice text. */
export const NOTICE: string;

/**
 * Whether the notice should be shown for the given environment. True only for
 * a global install (`npm install -g`), never when the package is a dependency
 * of another project.
 */
export function shouldShowNotice(env?: Record<string, string | undefined>): boolean;

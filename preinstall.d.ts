/**
 * Types for `preinstall.js`. // implements XSPEC-365 R1
 *
 * The hook itself is plain JavaScript because it runs before anything is
 * compiled — see that file's header. This declaration exists so
 * `test/preinstall.test.ts` can assert the message text without an install.
 */

/**
 * The install-time preflight message for `platform`, or `null` when every
 * native dependency ships a prebuilt binary there.
 */
export function preflightMessage(platform?: string): string | null;

/**
 * Names of `.engramgraph-<hash>` directories next to the installed package that
 * npm left after an upgrade (issue #26). Empty unless `packageDir` is
 * `<...>/node_modules/engramgraph`. A retired copy that still has its
 * `package.json` is npm's own in-flight copy of the previous version, not a
 * leftover, and is not listed.
 */
export function findUpgradeLeftovers(packageDir?: string): string[];

/** The warning for those names, or `null` for an empty list. */
export function leftoverMessage(names: string[], packageDir?: string): string | null;

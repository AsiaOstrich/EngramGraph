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

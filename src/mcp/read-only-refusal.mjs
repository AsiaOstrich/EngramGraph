// SPDX-License-Identifier: MIT
// implements XSPEC-457
/**
 * What a read-only MCP server's refusal looks like, defined in ONE place.
 *
 * Two parties need to agree on this wording:
 *   - the server, which says it (`readOnlyRefusal` in `server.ts`);
 *   - anyone who has to recognise it — `scripts/windows-release-verify.mjs`
 *     step 6, whose pass condition is "the MCP `related` tool refused".
 *
 * They used to agree by each carrying a copy. XSPEC-457 R1 rewrote the
 * server's sentence, the verifier kept the old one, and nothing connected
 * them: 0.13.0-beta.1 was published, the Windows workflow ran, and step 6
 * failed on a correct refusal (run 37818731887). A correct product was
 * reported broken because the thing judging it was a stale copy.
 *
 * Plain `.mjs` with no imports on purpose: the verifier runs from a bare
 * checkout with `node` (no build, no `npm install`), against a package that
 * may be older than the checkout, so it cannot take this from the installed
 * package — it takes it from here, and the server bundles the same file.
 * `read-only-refusal.d.mts` carries the types.
 */

/**
 * The fixed phrase every read-only refusal contains. The server builds its
 * sentence around it (`<tool> <MARKER>: it only reads the graph, …`), so the
 * wording cannot change here without the server changing with it; and
 * `test/windows-release-verify.test.ts` pins a real sample of what a published
 * server said, so it cannot be changed on both sides at once unnoticed either.
 */
export const READ_ONLY_REFUSAL_MARKER = "is not available through this MCP server";

/**
 * Wording of releases that predate {@link READ_ONLY_REFUSAL_MARKER}. The
 * verifier accepts a release by dist-tag or version, so `latest` (0.12.x, which
 * says "<tool> needs write access, …") must still be recognisable. Add to this
 * list when the wording changes again; never replace the marker with it.
 */
export const LEGACY_REFUSAL_MARKERS = ["needs write access"];

/**
 * Is this MCP `tools/call` result a read-only refusal?
 *
 * Both halves matter. `isError` alone would accept "node not found" or a lock
 * held by a writer — failures that are not the refusal. The phrase alone would
 * accept a successful answer that merely mentions it (a doc node quoting this
 * very sentence). A refusal is a tool-level ERROR that carries the phrase.
 *
 * @param {unknown} result the `result` member of a `tools/call` response
 *                         (or the SDK's `callTool` return value)
 * @returns {boolean}
 */
export function isReadOnlyRefusal(result) {
  if (!result || typeof result !== "object" || result.isError !== true) return false;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n");
  return [READ_ONLY_REFUSAL_MARKER, ...LEGACY_REFUSAL_MARKERS].some((m) => text.includes(m));
}

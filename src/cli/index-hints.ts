/**
 * Next-step hints printed under `egr index`'s summary.
 *
 * Consumer feedback on 0.11.0 (2026-09-15, Windows, a C# .NET Framework repo):
 * the summary read `1076 calls ... (ambiguous 534, unresolved 5972)` and
 * `142 doc(s) scanned, 137 unnamed` with `0 implements`. Every number was
 * accurate, and none of them told the reader what would change it. `--scip`
 * already existed and was documented in docs/CLI.md; the naming and
 * `// implements` conventions lived only as a table row in docs/MCP.md. The
 * reporter was looking at the terminal, not at either file.
 *
 * Pure functions so the wording and the trigger conditions can be tested
 * without indexing anything; `index.ts` only concatenates what they return.
 */

export interface CallCounts {
  calls: number;
  ambiguous: number;
  unresolved: number;
}

/**
 * When more call sites were dropped than linked, name the one flag that can
 * link them.
 *
 * Worded as information, not as a fault: on a real repository most unresolved
 * calls go to framework or library code that is simply not in the graph, and
 * calling that a failure would send people chasing something that is working
 * as designed.
 */
export function callResolutionHint(code: CallCounts, scipUsed: boolean): string {
  if (scipUsed) return "";
  const dropped = code.ambiguous + code.unresolved;
  if (dropped <= code.calls) return "";
  return (
    `\nhint: ${dropped} call site(s) were not linked (${code.ambiguous} ambiguous, ${code.unresolved} unresolved) — ` +
    `more than the ${code.calls} that were. Unresolved calls usually go to code outside this repo (framework, packages); ` +
    `ambiguous ones match more than one function by name. For precise callers, overlay a SCIP index with ` +
    `--scip <file> (e.g. scip-dotnet for C#, scip-java for Java) — see docs/CLI.md.`
  );
}

export interface KnowledgeCounts {
  docsScanned: number;
  docsUnresolved: readonly string[];
  specs: number;
  decisions: number;
}

/**
 * Explain the two conventions the knowledge graph depends on, only when the
 * counts show they are not being met.
 *
 * @param clusterWarned `true` when `unresolvedIdClusters` already printed a
 *   prefix warning — that warning is more specific, and saying the general rule
 *   under it would be noise.
 */
export function knowledgeNamingHint(
  k: KnowledgeCounts | undefined,
  implementsCount: number,
  clusterWarned: boolean,
): string {
  if (!k) return "";
  let out = "";
  if (k.docsUnresolved.length > 0 && !clusterWarned) {
    out +=
      `\nhint: ${k.docsUnresolved.length} of ${k.docsScanned} document(s) were not recognised as a spec or decision. ` +
      `A document is recognised when its front-matter \`id\`, its filename, or its first \`#\` heading starts with ` +
      `XSPEC-, SPEC-, DEC- or ADR- followed by a number or a name (e.g. SPEC-42, ADR-7, SPEC-EXTERNAL-AUTH). ` +
      `Other documents are left out on purpose.`;
  }
  if (k.specs > 0 && implementsCount === 0) {
    out +=
      `\nhint: ${k.specs} spec(s) indexed, but no code declares that it implements one. ` +
      `Add a comment such as \`// implements SPEC-42\` (or \`@implements\` / \`@spec\`) in the file that implements it; ` +
      `\`egr implementers\` and \`egr impact\` read those links. Only SPEC-/XSPEC- ids can be implemented.`;
  }
  return out;
}

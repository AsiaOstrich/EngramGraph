/**
 * Per-file parse-health measurement (XSPEC-334 R1b).
 *
 * tree-sitter is an *error-recovery* parser: malformed source never throws,
 * it yields a tree with `ERROR`/`MISSING` nodes and the surrounding valid
 * regions still parse. Before XSPEC-334, `collectExtraction` never looked at
 * `tree.rootNode.hasError` at all — a file 30% eaten by a grammar gap indexed
 * "successfully" with silently-missing nodes/edges, and a querier got an
 * incomplete answer with no signal it was incomplete. This module turns that
 * silent partial-parse into a **raw measurement** attached to each file.
 *
 * ## Deliberately raw, not classified (XSPEC-334 R1b / Non-goals)
 *
 * We record raw numbers (error-node count, error extent, source extent,
 * definitions yielded) — NOT a stable "diagnostic code" taxonomy. A stable
 * code is a public contract that can never be renumbered or re-split once
 * emitted; designing that classification before observing the real
 * distribution of failures across languages/grammar-versions would bake in a
 * wrong first cut. The CLI/consumers derive a coarse clean/partial/failed
 * *view* from these raw numbers at read time (see `parse-manifest.ts`'s
 * `summarize`), which is a throwaway rollup, not a persisted taxonomy.
 *
 * ## Units
 *
 * tree-sitter's `startIndex`/`endIndex` are **UTF-16 code-unit offsets** into
 * the JS source string (verified empirically: `rootNode.endIndex === source
 * .length`, not `Buffer.byteLength(source)` — the two differ for any
 * multi-byte character). "extent" here is therefore in the same code-unit
 * unit as `source.length`, NOT UTF-8 bytes — the `errorExtent / sourceExtent`
 * ratio is unit-consistent regardless, but the fields are named "extent" (not
 * "bytes") to avoid claiming a byte count they are not.
 */

import type Parser from "tree-sitter";

import type { SupportedLanguage } from "./types.js";

/**
 * Raw parse-health record for one file. No classification, no diagnostic
 * codes — see this module's doc comment for why.
 */
export interface FileParseHealth {
  /** Repo-relative, `/`-normalized path (same id basis as the Module node). */
  path: string;
  language: SupportedLanguage;
  /**
   * Count of top-most `ERROR` + `MISSING` nodes. Nested errors are counted
   * once (the whole error subtree is one measurement), so this is "how many
   * distinct places the parse broke", not "how many error nodes exist".
   */
  errorNodes: number;
  /**
   * Combined extent (UTF-16 code units — see module doc) covered by those
   * top-most error nodes. `MISSING` nodes are zero-width, so they raise
   * `errorNodes` without raising `errorExtent`.
   */
  errorExtent: number;
  /** Total source extent in the same unit (`source.length`). */
  sourceExtent: number;
  /**
   * Function nodes the tag query yielded for this file. Zero on a non-empty
   * source file is itself a signal (grammar produced no matchable
   * definitions), independent of `errorNodes`.
   */
  functions: number;
  /** Class nodes the tag query yielded. */
  classes: number;
  /**
   * Present iff `collectExtraction` *threw* for this file (R1a per-file fault
   * tolerance) — the file contributed nothing to the graph and every other
   * count above is zero/best-effort. Holds the error MESSAGE only, truncated
   * (see `extractProject`). It is not *designed* to carry source text, but the
   * message originates in arbitrary downstream code, so treat "no source text"
   * as best-effort-plus-truncation, not a hard guarantee — a caller forwarding
   * this anywhere external should re-check. Absent on a normal (even if
   * partial) parse.
   */
  failed?: string;
}

/**
 * Walk a parsed tree counting top-most `ERROR`/`MISSING` nodes and the extent
 * they cover. Does NOT descend into an error node's own children (the whole
 * broken subtree counts once), so nested recovery errors do not inflate the
 * count. Callers should guard with `root.hasError` first — this returns
 * `{ 0, 0 }` for a clean tree anyway, but the walk is wasted work then.
 */
export function measureErrorSpan(root: Parser.SyntaxNode): { errorNodes: number; errorExtent: number } {
  let errorNodes = 0;
  let errorExtent = 0;
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      errorNodes += 1;
      errorExtent += node.endIndex - node.startIndex;
      continue; // the whole error subtree counts once — do not descend
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  return { errorNodes, errorExtent };
}

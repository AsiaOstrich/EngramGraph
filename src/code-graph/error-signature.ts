/**
 * Parse-failure signatures (XSPEC-334 R3a, Phase A).
 *
 * A single grammar gap usually produces MANY partial files with the SAME
 * structural failure — e.g. the 48 partial `.ts` files in the cross-repo index
 * were really TWO gaps (`export type *` and `f<typeof import()>()`). A
 * signature fingerprints an ERROR/MISSING node's structural NEIGHBORHOOD so
 * those collapse into a handful of buckets, turning "48 files broken" into "2
 * distinct failure types" — the actionable unit for prioritising a fix.
 *
 * ## Privacy: node TYPES only, never text (build-time guarantee)
 *
 * The skeleton is built exclusively from `node.type` — grammar-defined symbol
 * names (`binary_expression`, `ERROR`, `identifier`, …), which are the
 * grammar's vocabulary, not the user's source. It never touches `node.text`,
 * so identifiers, string literals and comments cannot leak into a signature.
 * This is the same "only structural, never source" line R1's manifest holds,
 * enforced structurally here (the function has no access to source text).
 *
 * ## Grammar version is part of the signature (drift = new signature)
 *
 * The signature embeds `language@grammarVersion`, so the same structural gap
 * under a different grammar version is a DIFFERENT signature. That is
 * intended (XSPEC-334 R3a): a grammar upgrade legitimately changes the parse,
 * and healing is tracked at the file level (R1d's healed/regressed diff), not
 * by signature equality across versions.
 *
 * ## Scope: Phase A only
 *
 * This computes signatures and (via `egr signatures`) buckets current
 * blindspots by them. The stateful temporal ledger the XSPEC also describes
 * (first-seen / consecutive-run counts, for transient filtering before a
 * telemetry upload) is deferred to Phase B — its only consumer is the armed,
 * not-yet-built telemetry path, so building it now would be infra for a
 * deferred consumer.
 */

import { createHash } from "node:crypto";

import type Parser from "tree-sitter";

import type { SupportedLanguage } from "./types.js";
import { grammarVersions } from "./parse-manifest.js";

/** language → grammar package name, for versioning a signature. */
const LANGUAGE_PACKAGE: Record<SupportedLanguage, string> = {
  typescript: "tree-sitter-typescript",
  tsx: "tree-sitter-typescript",
  javascript: "tree-sitter-javascript",
  csharp: "tree-sitter-c-sharp",
  python: "tree-sitter-python",
  go: "tree-sitter-go",
  java: "tree-sitter-java",
  kotlin: "@tree-sitter-grammars/tree-sitter-kotlin",
  rust: "tree-sitter-rust",
  cpp: "tree-sitter-cpp",
  ruby: "tree-sitter-ruby",
  php: "tree-sitter-php",
  dart: "@vokturz/tree-sitter-dart",
};

const SUBTREE_KIND_LIMIT = 6;

/** The resolved grammar version for a language, or "unknown" if unreadable. */
function grammarVersionFor(language: SupportedLanguage): string {
  return grammarVersions()[LANGUAGE_PACKAGE[language]] ?? "unknown";
}

/**
 * A privacy-safe structural skeleton for one error node — node TYPES only.
 *
 * Deliberately **position-robust** so the SAME grammar gap in different
 * surrounding contexts collapses to ONE bucket: it uses only the error's
 * IMMEDIATE parent type + the top-level child kinds of the error subtree (the
 * shape of what actually broke). It intentionally does NOT include the parent
 * *chain* (nesting depth) or the previous sibling (the preceding statement) —
 * both were measured to scatter one gap across many buckets purely by where it
 * appeared (an adversarial review found `f<typeof import()>()` splitting into
 * 3 buckets by nesting depth under a depth-3 + prev-sibling skeleton; immediate
 * parent + kids merges all positions to 1 while still separating it from a
 * different gap like `export type *`). Residual limitation: a gap whose ERROR
 * node's IMMEDIATE parent legitimately varies by context can still split — this
 * is a Phase-A heuristic, not an exact grammar-gap identity.
 */
function skeleton(node: Parser.SyntaxNode): string {
  const parent = node.parent?.type ?? "none";
  const kinds: string[] = [];
  for (let i = 0; i < node.childCount && kinds.length < SUBTREE_KIND_LIMIT; i++) {
    const c = node.child(i);
    if (c) kinds.push(c.type);
  }
  const self = node.isMissing ? `MISSING(${node.type})` : "ERROR";
  return `${self}|parent=${parent}|kids=${kinds.join(",")}`;
}

/**
 * Signatures for every top-most ERROR/MISSING node under `root`, deduplicated
 * within the file (a file that hits the same gap twice yields one signature).
 * Each is `<language>@<grammarVersion>:<12-hex-hash>`. Returns `[]` for a clean
 * tree — guard with `root.hasError` to skip the walk entirely.
 */
export function errorSignatures(root: Parser.SyntaxNode, language: SupportedLanguage): string[] {
  const version = grammarVersionFor(language);
  const sigs = new Set<string>();
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      const raw = `${language}@${version}|${skeleton(node)}`;
      const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
      sigs.add(`${language}@${version}:${hash}`);
      continue; // whole error subtree is one signature — do not descend
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  return [...sigs];
}

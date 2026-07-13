/**
 * Reference linker — classify an artifact id into a graph node kind.
 *
 * XSPEC-NNN / SPEC-NNN → Spec; DEC-NNN / ADR-NNN → Decision. Tolerates
 * surrounding text (e.g. a `[[SPEC-240（dry-run）]]` link or a heading) by
 * extracting the canonical id token.
 *
 * `XSPEC-NNN` (dev-platform's cross-project specs) and `SPEC-NNN` (a
 * sub-project's local specs) are *distinct* id namespaces — the `X` prefix is
 * preserved, never normalised to `SPEC-NNN`.
 */

import type { KnowledgeNodeKind } from "./types.js";

// `XSPEC` must precede `SPEC` in the alternation so `XSPEC-190` matches the
// longer prefix first. `\b` still prevents matching `SPEC` mid-word (e.g.
// `MYSPEC-5`), while allowing the `X` boundary in `XSPEC-190`.
const ID_RE = /\b(XSPEC|SPEC|DEC|ADR)-\d+/i;
/** Global variant for extracting *all* ids from a blob (comments/front-matter). */
const ID_RE_GLOBAL = /\b(XSPEC|SPEC|DEC|ADR)-\d+/gi;

function isSpecPrefix(prefix: string): boolean {
  return prefix === "SPEC" || prefix === "XSPEC";
}

export interface ClassifiedRef {
  kind: KnowledgeNodeKind;
  /** Canonical upper-case id, e.g. `XSPEC-331`, `SPEC-205`, `DEC-062`. */
  id: string;
}

/**
 * Extract and classify the first artifact id in `ref`, or null if none is
 * present.
 */
export function classifyRef(ref: string): ClassifiedRef | null {
  const match = ID_RE.exec(ref);
  if (!match) return null;
  const id = match[0].toUpperCase();
  const prefix = (match[1] ?? "").toUpperCase();
  const kind: KnowledgeNodeKind = isSpecPrefix(prefix) ? "Spec" : "Decision";
  return { kind, id };
}

/**
 * Extract the canonical Spec ids a code comment declares it *implements*.
 *
 * Only fires when the comment actually contains the `implements` keyword (the
 * `// implements XSPEC-190` convention), so a casual `// see SPEC-123 for
 * rationale` never produces a spurious IMPLEMENTS edge. Returns only Spec-kind
 * ids (XSPEC/SPEC) — a file "implements" a spec, not a decision — and ignores
 * sub-references like `AC-3` (not an artifact prefix). Ids are de-duplicated.
 */
export function extractImplementsSpecs(comment: string): string[] {
  if (!/\bimplements\b/i.test(comment)) return [];
  const ids = new Set<string>();
  for (const match of comment.matchAll(ID_RE_GLOBAL)) {
    const prefix = (match[1] ?? "").toUpperCase();
    if (isSpecPrefix(prefix)) ids.add(match[0].toUpperCase());
  }
  return [...ids];
}

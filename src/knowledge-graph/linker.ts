/**
 * Reference linker — classify an artifact id into a graph node kind.
 *
 * SPEC-NNN → Spec; DEC-NNN / ADR-NNN → Decision. Tolerates surrounding text
 * (e.g. a `[[SPEC-240（dry-run）]]` link or a heading) by extracting the
 * canonical id token.
 */

import type { KnowledgeNodeKind } from "./types.js";

// `\b` avoids matching SPEC inside another word. SPEC → Spec; DEC/ADR → Decision.
const ID_RE = /\b(SPEC|DEC|ADR)-\d+/i;

export interface ClassifiedRef {
  kind: KnowledgeNodeKind;
  /** Canonical upper-case id, e.g. `SPEC-205`, `DEC-062`, `ADR-001`. */
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
  const kind: KnowledgeNodeKind = prefix === "SPEC" ? "Spec" : "Decision";
  return { kind, id };
}

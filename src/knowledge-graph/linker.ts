/**
 * Reference linker — classify an artifact id into a graph node kind.
 *
 * XSPEC-NNN / SPEC-NNN → Spec; DEC-NNN / ADR-NNN → Decision. Tolerates
 * surrounding text (e.g. a `[[SPEC-240（dry-run）]]` link or a heading) by
 * extracting the canonical id token.
 *
 * `XSPEC-NNN` (dev-platform's cross-project specs) and `SPEC-NNN` (a
 * sub-project's local specs) are *distinct* id namespaces — the `X` prefix is
 * preserved, never normalised to `SPEC-NNN`. `XADR-NNN`/`ADR-NNN` are the same
 * pairing for decisions.
 */

import type { KnowledgeNodeKind } from "./types.js";

// `XSPEC` must precede `SPEC` in the alternation so `XSPEC-190` matches the
// longer prefix first. `\b` still prevents matching `SPEC` mid-word (e.g.
// `MYSPEC-5`), while allowing the `X` boundary in `XSPEC-190`.
/**
 * Artifact prefixes, longest-first where one contains another.
 *
 * `XSPEC` must precede `SPEC` and `XADR` must precede `ADR`, because
 * alternation is leftmost-wins: with `ADR` first, `XADR-001` would match the
 * trailing `ADR-001` — except `\b` forbids a boundary inside `XADR`, so it
 * would match NOTHING AT ALL. That is not hypothetical. dev-platform's three
 * cross-project ADRs (`XADR-001`…`XADR-003`) were silently absent from its
 * graph until `unresolvedIdClusters` named the prefix — the first real find
 * that warning made, on the very repository that wrote it.
 */
const PREFIX = "XSPEC|SPEC|XADR|ADR|DEC";

/**
 * The suffix after `PREFIX-`. Widened from `\d+` (XSPEC-373 R4a) so that
 * semantically-named ids — `SPEC-EXTERNAL-AUTH`, `SPEC-LOGIN` — are recognised
 * alongside numeric ones.
 *
 * ## Numeric first, and why that is not a stylistic choice
 *
 * "`-\d+` is a subset of the wider pattern, so existing ids keep working" is
 * true about WHETHER a string matches and false about WHAT it matches. A
 * numeric project names its files `XSPEC-373-index-result.md`: id then
 * description. A single greedy alternative swallows the description too and
 * yields `XSPEC-373-INDEX-RESULT`, which no longer equals the `[[XSPEC-373]]`
 * its own documents link to — every edge in such a repo would silently detach.
 * That is not hypothetical: it broke `knowledge-graph.test.ts`'s `DEC-099-foo`
 * case the moment the widened pattern landed, and dev-platform's whole corpus
 * is named this way.
 *
 * So the numeric form is tried FIRST and alternation is leftmost-wins: a
 * numeric id stops at its digits and never absorbs a trailing description,
 * while a suffix that does not start with digits falls through to the
 * semantic form. `SPEC-2FA` is why the numeric branch also refuses to stop
 * mid-token — `\d+` alone would clip it to `SPEC-2`.
 *
 * Known trade-off: `SPEC-001-LOGIN` resolves to `SPEC-001`, the numeric id
 * with a description, because that reading is far more common than a
 * deliberate number-then-word id — and it is what this codebase did before.
 *
 * ## Bounds on the semantic form
 *
 * Widening has to stop short of "anything after a dash":
 *   - it must START with an alphanumeric, so `SPEC--x` and a bare `SPEC-` do
 *     not match;
 *   - it must END with an alphanumeric, so a trailing separator is left out of
 *     the id (`SPEC-LOGIN-` yields `SPEC-LOGIN`), which keeps prose like
 *     "see SPEC-LOGIN - the auth one" from minting a variant.
 * With the literal prefix and the leading `\b`, an id is always an anchored
 * token with a non-empty fixed head — never an arbitrary string.
 */
const NUMERIC_SUFFIX = "\\d+(?![A-Za-z0-9_])";
const SEMANTIC_SUFFIX = "[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?";
const SUFFIX = `(?:${NUMERIC_SUFFIX}|${SEMANTIC_SUFFIX})`;

/**
 * ONE definition, several consumers. `parser.ts` used to carry its own copy
 * with a comment reading "mirrors linker's ID_RE" — two copies whose sync
 * engine is a human, which is the drift shape XSPEC-371 catalogues. Anything
 * needing to match ids imports from here instead of restating the pattern.
 */
const ID_RE = new RegExp(`\\b(${PREFIX})-${SUFFIX}`, "i");

/** Global variant for extracting *all* ids from a blob (comments/front-matter). */
const ID_RE_GLOBAL = new RegExp(`\\b(${PREFIX})-${SUFFIX}`, "gi");

/**
 * Every artifact id appearing in `text`, in order, de-duplicated, canonical
 * upper-case. Used for front-matter relationship fields, where one field can
 * list several ids.
 */
export function extractRefIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(ID_RE_GLOBAL)) ids.add(match[0].toUpperCase());
  return [...ids];
}

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
 * Markers that turn a comment into an implementation declaration.
 *
 * `implements` is this codebase's original convention (`// implements
 * XSPEC-190`). The `@`-prefixed forms are the mainstream one — Javadoc, JSDoc
 * and C# XML-doc all annotate with `@tag`, and a project declaring
 * `// @SPEC SPEC-EXTERNAL-AUTH` was previously invisible no matter how the id
 * pattern was widened, because this gate never fired (XSPEC-373 R4b).
 *
 * ## `\b` cannot be used uniformly here, and getting that wrong is silent
 *
 * The natural implementation of "make the keyword configurable" is
 * `new RegExp("\\b" + marker + "\\b", "i")`. For `@SPEC` that regex can NEVER
 * match: `\b` needs a word character on exactly one side, and both `@` and the
 * space before it are non-word, so the boundary does not exist. It compiles,
 * runs, and silently matches nothing — measured:
 * `/\b@SPEC\b/i.test("// @SPEC SPEC-EXTERNAL-AUTH")` is `false`.
 *
 * So `@` supplies its own left boundary and only the right one is asserted.
 * The trailing `\b` still matters: it keeps `@SPECIAL` and `@specification`
 * from being read as `@SPEC`.
 */
const IMPLEMENTS_MARKER = /\bimplements\b|@implements\b|@spec\b/i;

/**
 * Extract the canonical Spec ids a code comment declares it *implements*.
 *
 * Only fires when the comment carries one of `IMPLEMENTS_MARKER`'s forms, so a
 * casual `// see SPEC-123 for rationale` never produces a spurious IMPLEMENTS
 * edge. Returns only Spec-kind ids (XSPEC/SPEC) — a file "implements" a spec,
 * not a decision — and ignores sub-references like `AC-3` (not an artifact
 * prefix). Ids are de-duplicated.
 */
export function extractImplementsSpecs(comment: string): string[] {
  if (!IMPLEMENTS_MARKER.test(comment)) return [];
  const ids = new Set<string>();
  for (const match of comment.matchAll(ID_RE_GLOBAL)) {
    const prefix = (match[1] ?? "").toUpperCase();
    if (isSpecPrefix(prefix)) ids.add(match[0].toUpperCase());
  }
  return [...ids];
}

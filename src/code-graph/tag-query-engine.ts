/**
 * Generic tag-query execution engine (XSPEC-333 R2a).
 *
 * Replaces the hand-written recursive `visit()` walker that used to live in
 * extractor.ts with a declarative pipeline:
 *
 *   1. run a language's tag query (see `queries/`) against the parsed tree →
 *      a *flat* batch of definition/call captures (tree-sitter's Query API
 *      has no notion of "this definition is nested inside that one" — it
 *      just reports every place a pattern matched);
 *   2. reconstruct nested scopes from that flat batch by range containment
 *      (`qualifyFunctions`) — a definition D is lexically nested inside
 *      definition A exactly when A's byte range strictly contains D's. This
 *      is the same nesting the old walker built procedurally via a
 *      `scopeStack` pushed/popped during traversal, recovered here as a
 *      post-processing step instead;
 *   3. resolve each call site's enclosing function the same way
 *      (`findEnclosingFunction`) — the old walker's `currentFn` was simply
 *      "the innermost function definition whose body contains this node",
 *      which range containment gives directly without re-walking.
 *
 * `collectComments` is a plain full-tree walk, not a query — the
 * `// implements XSPEC-NNN` convention itself is pure comment-text regex,
 * unrelated to any language's grammar, so there is no language-specific
 * *pattern* to declare (see extractor.ts module doc / XSPEC-333 task notes).
 * **Correction (XSPEC-333 R2c)**: this file originally also assumed the
 * comment *node type name* itself was universal ("nothing language-specific
 * to declare" was too strong a claim). Verified false for Java: JS, TS, C#,
 * Python and Go's grammars all name it `comment`, but `tree-sitter-java`
 * splits it into `line_comment`/`block_comment` with no unifying `comment`
 * type at all — see `collectComments`'s own doc comment below for the fix
 * and why it was made despite this task batch otherwise being told this
 * file needs no changes (that instruction was the task-giver's untested
 * assumption, which this file's own empirical verification overrode; a
 * silently-broken IMPLEMENTS linkage for a whole new language is exactly the
 * kind of fail-silent gap this codebase's anti-hallucination stance exists
 * to catch before it ships, not defer past a literal instruction that
 * predates the evidence).
 */

import Parser from "tree-sitter";

/** A function or class definition captured by a language's tag query. */
export interface DefinitionCapture {
  kind: "function" | "class";
  name: string;
  node: Parser.SyntaxNode;
}

/** A call site: a bare callee name plus the node used to locate its scope. */
export interface CallSiteCapture {
  name: string;
  node: Parser.SyntaxNode;
}

/**
 * A module-relationship reference — C's `#include "foo.h"` / `#include
 * <foo.h>`, Bash's `source lib.sh` / `. lib.sh` (XSPEC-414 R2/R4). `target`
 * is the raw captured text with the language's own include punctuation
 * stripped ({@link cleanImportTarget}) — still relative/unresolved; turning
 * it into an actual Module→Module edge requires the whole file batch
 * (`extractor.ts`'s `extractProject` does that), which this per-file query
 * step has no access to.
 */
export interface ImportCapture {
  target: string;
  node: Parser.SyntaxNode;
}

export interface TagQueryResult {
  /** Sorted by byte position ascending — i.e. document / pre-order. */
  definitions: DefinitionCapture[];
  /** Sorted by byte position ascending. */
  callSites: CallSiteCapture[];
  /** Unresolved, in document order. Empty for every language that doesn't capture `@reference.import`. */
  imports: ImportCapture[];
}

/**
 * Strip the punctuation an include/source target is written with, leaving a
 * bare path string. Handles C's `#include "foo.h"` (double-quoted) and
 * `#include <foo.h>` (angle-bracket "system" convention, kept — not
 * special-cased away — because it costs nothing: a system header's bare name
 * essentially never coincides with a path inside the indexed project, so it
 * naturally fails to resolve to any Module rather than needing to be
 * recognized and excluded up front) as well as Bash's `source lib.sh` / `.
 * lib.sh` (a bare word, no punctuation at all — left unchanged; also covers
 * a quoted Bash path, `source "lib.sh"`, the same way as C's quoted form).
 */
export function cleanImportTarget(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "<" && last === ">")
    ) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * One compiled tree-sitter Query per language; construction is not free.
 * Keyed by the caller-supplied `queryCacheKey` (extractor.ts uses the
 * `SupportedLanguage` value) — callers MUST keep that key 1:1 with a given
 * `(language, queryString)` pair. A `Query` is compiled against a specific
 * `Language`'s internal symbol table, so reusing a cached entry under the
 * same key but a different `language`/`queryString` would silently run the
 * wrong compiled query. The assertion below turns that misuse into an
 * immediate throw instead of a silent wrong-result bug.
 */
const queryCache = new Map<string, { query: Parser.Query; language: Parser.Language; queryString: string }>();

/** Compile (once) and run the tag query for `language` against `root`. */
export function runTagQuery(
  language: Parser.Language,
  queryCacheKey: string,
  queryString: string,
  root: Parser.SyntaxNode,
): TagQueryResult {
  let cached = queryCache.get(queryCacheKey);
  if (!cached) {
    cached = { query: new Parser.Query(language, queryString), language, queryString };
    queryCache.set(queryCacheKey, cached);
  } else if (cached.language !== language || cached.queryString !== queryString) {
    throw new Error(
      `runTagQuery: cache key "${queryCacheKey}" was previously compiled for a different ` +
        `language/query — a query cache key must map 1:1 to one (language, queryString) pair.`,
    );
  }
  const query = cached.query;

  const definitions: DefinitionCapture[] = [];
  const callSites: CallSiteCapture[] = [];
  const imports: ImportCapture[] = [];

  for (const match of query.matches(root)) {
    let defKind: "function" | "class" | null = null;
    let defNode: Parser.SyntaxNode | null = null;
    let name: string | null = null;
    let callNode: Parser.SyntaxNode | null = null;

    for (const capture of match.captures) {
      switch (capture.name) {
        case "reference.import":
          imports.push({ target: cleanImportTarget(capture.node.text), node: capture.node });
          break;
        case "definition.function":
          defKind = "function";
          defNode = capture.node;
          break;
        case "definition.class":
          defKind = "class";
          defNode = capture.node;
          break;
        case "name":
          name = capture.node.text;
          break;
        case "reference.call":
          callNode = capture.node;
          break;
        case "reference.call.arg":
          callSites.push({ name: capture.node.text, node: capture.node });
          break;
      }
    }

    if (defKind && defNode && name) {
      definitions.push({ kind: defKind, name, node: defNode });
    } else if (callNode && name) {
      if (!isPlainAssignmentTarget(callNode)) callSites.push({ name, node: callNode });
    }
  }

  imports.sort((a, b) => a.node.startIndex - b.node.startIndex);

  // Query match order is not documented to be strictly document-ordered
  // across distinct patterns; sort explicitly so downstream logic that
  // depends on document order (scope-nesting reconstruction, "last
  // definition wins" for duplicate bare names — see qualifyFunctions) is
  // deterministic and matches the old pre-order-DFS walker exactly.
  definitions.sort((a, b) => a.node.startIndex - b.node.startIndex);
  callSites.sort((a, b) => a.node.startIndex - b.node.startIndex);

  return { definitions, callSites, imports };
}

/**
 * True when `node` is itself the LHS of a plain (`=`, never `+=`/`||=`/etc.)
 * assignment — either directly (`assignment left: (node)`) or as one element
 * of a multi-assignment (`assignment left: (left_assignment_list ... (node)
 * ...)`).
 *
 * Fix for XSPEC-333 R2c batch 3's Ruby adversarial-review finding: Ruby has
 * no distinct "attribute access" node (see queries/ruby.ts's module doc
 * comment) — `obj.name` is a `call` node whether it appears as a genuine
 * zero-arg method invocation OR as the left-hand side of `obj.name = x`
 * (Ruby dispatches this to a DIFFERENT method, `name=`, never `name` — the
 * `call` node for `obj.name` on an assignment's LHS is never actually
 * invoked at runtime at all). Without this filter, a plain `(call
 * method: (identifier) @name) @reference.call` pattern — Ruby's own,
 * correctly-designed, receiver-agnostic call pattern — fabricates a CALLS
 * edge to a coincidentally-same-named getter every time a real setter is
 * used, confirmed empirically (`obj.name = x` in a method alongside a
 * `def name` getter produced a real, wrong `CALLS` edge to that getter
 * before this fix). Deliberately scoped to plain `assignment` only —
 * compound assignment (`assignment operator: obj.count += 1`, this
 * grammar's distinct `operator_assignment` node type, NOT `assignment`) is
 * NOT excluded, because it genuinely reads the current value through the
 * getter before writing it back through the setter, verified against a real
 * parse that `operator_assignment`'s `left:` field is the same `call` shape
 * — a real invocation this time, correctly left captured.
 *
 * Implemented here (language-agnostic, keyed only on the standard `.parent`/
 * `.childForFieldName` SyntaxNode API) rather than in queries/ruby.ts,
 * because tree-sitter's query DSL has no "this node is NOT under an
 * ancestor of shape X" construct — matching only ever composes top-down
 * (parent pattern containing child patterns), never bottom-up. Verified
 * harmless for every other language on this engine: none of their grammars
 * produce a `call`-shaped node for a plain (non-invoking) attribute/property
 * read in the first place (each has its own distinct member-access node
 * type our `@reference.call` patterns never target), so this filter is a
 * no-op for them regardless of what their own `assignment`-equivalent node
 * happens to be named.
 */
function isPlainAssignmentTarget(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "assignment") {
    return parent.childForFieldName("left") === node;
  }
  if (parent.type === "left_assignment_list") {
    const grandparent = parent.parent;
    return !!grandparent && grandparent.type === "assignment" && grandparent.childForFieldName("left") === parent;
  }
  return false;
}

/** A function definition after scope-qualification. */
export interface QualifiedFunction {
  id: string;
  name: string;
  startLine: number;
  node: Parser.SyntaxNode;
}

/** A class definition (ids are never scope-qualified — see below). */
export interface QualifiedClass {
  name: string;
  node: Parser.SyntaxNode;
}

/**
 * Reconstruct the old walker's `scopeStack`-qualified function ids from a
 * flat batch of definition captures, using byte-range containment: A is an
 * ancestor of D iff A's range strictly contains D's range. Both function and
 * class definitions contribute a name segment to a *function's* qualified
 * id, ordered outermost → innermost (exactly what the walker's scopeStack
 * held at the point it computed each function's identity) — but a *class*
 * node's own id is `${filePath}#class:${name}`, never itself
 * scope-qualified, matching the original code exactly (a pre-existing
 * quirk — e.g. two same-named nested classes in one file would collide —
 * that this refactor preserves rather than "fixes").
 *
 * Cost: this is O(n²) in the number of definitions per file (each
 * definition scans every other one for containment), vs. the old walker's
 * O(n) single pass — an accepted tradeoff for one file's worth of
 * definitions (hundreds, not the tens of thousands where O(n²) would bite).
 */
export function qualifyFunctions(
  filePath: string,
  definitions: DefinitionCapture[],
): { functions: QualifiedFunction[]; classes: QualifiedClass[] } {
  function ancestorsOf(target: DefinitionCapture): DefinitionCapture[] {
    const ancestors: DefinitionCapture[] = [];
    for (const candidate of definitions) {
      if (candidate === target) continue;
      const contains =
        candidate.node.startIndex <= target.node.startIndex &&
        candidate.node.endIndex >= target.node.endIndex;
      const strictlyLarger =
        candidate.node.startIndex < target.node.startIndex ||
        candidate.node.endIndex > target.node.endIndex;
      if (contains && strictlyLarger) ancestors.push(candidate);
    }
    // outermost → innermost (mirrors scopeStack push order during the walk)
    ancestors.sort((a, b) => a.node.startIndex - b.node.startIndex);
    return ancestors;
  }

  const functions: QualifiedFunction[] = [];
  const classes: QualifiedClass[] = [];

  for (const def of definitions) {
    if (def.kind === "class") {
      classes.push({ name: def.name, node: def.node });
      continue;
    }
    const scopeNames = ancestorsOf(def).map((a) => a.name);
    const qualified = scopeNames.length > 0 ? `${scopeNames.join(".")}.${def.name}` : def.name;
    functions.push({
      id: `${filePath}#${qualified}`,
      name: def.name,
      startLine: def.node.startPosition.row + 1,
      node: def.node,
    });
  }

  return { functions, classes };
}

/**
 * Find the innermost function definition whose range *fully contains*
 * `site`'s range — the range-containment equivalent of the old walker's
 * `currentFn`, which was updated to the nearest enclosing function each time
 * the walk entered one (classes never set `currentFn`, only
 * functions/methods do, so only `functions` — never `classes` —
 * participate here).
 *
 * Containment must check *both* ends of `site`'s range, not just whether its
 * start falls inside `[fn.startIndex, fn.endIndex]`: tree-sitter's
 * `endIndex` is the exclusive byte just past a node's last byte, so a node
 * immediately adjacent to (not inside) a function — e.g. `g()` in
 * `function f(){}g();` — has `startIndex === f.endIndex`, which a
 * start-only, inclusive-end check would wrongly treat as "inside `f`".
 */
export function findEnclosingFunction(
  functions: QualifiedFunction[],
  site: Parser.SyntaxNode,
): QualifiedFunction | null {
  let best: QualifiedFunction | null = null;
  let bestSize = Infinity;
  for (const fn of functions) {
    if (fn.node.startIndex <= site.startIndex && site.endIndex <= fn.node.endIndex) {
      const size = fn.node.endIndex - fn.node.startIndex;
      if (size < bestSize) {
        best = fn;
        bestSize = size;
      }
    }
  }
  return best;
}

/**
 * Every comment node's text, anywhere in the tree — a plain full-tree walk,
 * not a query. The `// implements XSPEC-NNN` convention is pure comment-text
 * regex (see `../knowledge-graph/linker.ts`), unrelated to any language's
 * grammar, so there is no language-specific *pattern* to declare — but the
 * comment *node type name* itself is not actually universal across grammars,
 * despite this function's original (JS/TS/C#) assumption that it was.
 * JS, TS, C#, Python and Go's grammars all name it `comment` (verified
 * against each grammar's node-types.json / a real parse — XSPEC-333 R2c) —
 * but `tree-sitter-java` splits it into two distinct node types,
 * `line_comment` and `block_comment`, with no unifying `comment` type at
 * all. Without this, `// implements XSPEC-NNN` in a `.java` file would
 * silently produce zero IMPLEMENTS edges — no error, just quietly missing
 * linkage, exactly the kind of gap this codebase's `// implements` feature
 * exists to prevent. Broadening the match to all three names is safe for
 * every other language: `line_comment`/`block_comment` are not node type
 * names in any of the other bundled grammars (confirmed by grepping each
 * grammar's node-types.json), so this cannot start matching some unrelated
 * non-comment node elsewhere. Pulled into a `Set` (rather than three
 * separate `===` checks) so the next language with its own split naming
 * (e.g. Rust also uses `line_comment`/`block_comment` — same names Java
 * uses, so it would already be covered for free) is a one-line addition
 * here instead of another silent per-language gap discovered the hard way.
 */
// XSPEC-333 R2c batch 3 (Ruby/PHP/Dart): Ruby and PHP both name their comment
// node plain "comment" (confirmed against each node-types.json), no change
// needed there. @vokturz/tree-sitter-dart has its own three-way split,
// verified against a real parse: "//" and "/* */" both produce the ordinary
// "comment" node (unlike Java/Rust's line/block split), but a "///" doc
// comment -- an extremely common convention in real Dart (dartdoc), and a
// very plausible place for a real project to write "/// implements
// XSPEC-NNN" -- is its OWN distinct node type, "documentation_comment", not
// unified with plain "comment" at all. Without this fourth entry, a "///
// implements XSPEC-NNN" comment in a .dart file would silently produce zero
// IMPLEMENTS edges -- the same silent-gap shape Java's discovery predicted
// this Set would need to absorb one day.
// XSPEC-414 R3: `tree-sitter-swift`'s `//`/`///` line comment (doc or plain,
// both fold into the same "comment" node, unlike Dart's own line/doc split)
// is already covered by "comment" — but its `/* ... */` BLOCK comment is a
// DIFFERENT, fourth node type, "multiline_comment" (confirmed against a real
// parse; NOT named "block_comment", the name Java/Rust use for their own
// distinct block-comment node). Without this, a Swift file writing `/*
// implements XSPEC-NNN */` would silently produce zero IMPLEMENTS edges —
// caught by `test/comment-capture-per-grammar.test.ts`'s walked (not
// hand-enumerated) per-grammar check before it could ship as a silent gap.
const COMMENT_NODE_TYPES = new Set([
  "comment",
  "line_comment",
  "block_comment",
  "documentation_comment",
  "multiline_comment",
]);

export function collectComments(root: Parser.SyntaxNode): string[] {
  const texts: string[] = [];
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (COMMENT_NODE_TYPES.has(node.type)) texts.push(node.text);
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  return texts;
}

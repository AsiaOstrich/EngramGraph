/**
 * CodeGraph extractor — tree-sitter source → {@link GraphFragment}.
 *
 * Produces, per file:
 *  - one `Module` node (the file),
 *  - `Function` nodes for function declarations, class methods and arrow /
 *    function expressions bound to a variable,
 *  - `Class` nodes for class declarations,
 *  - `DEFINES` edges (Module → Function),
 *  - `CALLS` edges (Function → Function).
 *
 * {@link extractCodeGraph} resolves CALLS within a single file. For a whole
 * repository, {@link extractProject} resolves CALLS *across* files using a
 * global name index with the policy: same-file match wins (lexical shadowing),
 * else a unique global match, else the call is left unresolved (precision over
 * recall — import-aware resolution is future work).
 *
 * CALLS also fires when a known function is passed **by reference** as a
 * direct argument to some other call (e.g. Fastify's
 * `app.register(pluginFn, opts)`) — not just when it is invoked with `fn()`.
 * This is deliberately narrow: only a bare `identifier` that is a direct
 * (non-nested) argument counts, matching a real gap found comparing egr
 * against an external tool (`alertRulesRoutes` passed to `app.register` was
 * invisible to `callers()` before this; DEC-081/DEC-095 in dev-platform have
 * the comparison). An identifier buried inside an object/array literal
 * argument (e.g. `foo({ handler: bar })`) is intentionally *not* captured —
 * that is a materially weaker signal (the callee decides whether/when `bar`
 * ever runs) and widening scope there raises false-positive risk without a
 * concrete case to justify it.
 */

import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import CSharp from "tree-sitter-c-sharp";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import Kotlin from "@tree-sitter-grammars/tree-sitter-kotlin";
import Rust from "tree-sitter-rust";
import Cpp from "tree-sitter-cpp";
import Ruby from "tree-sitter-ruby";
import PhpModule from "tree-sitter-php";
import Dart from "@vokturz/tree-sitter-dart";

import { extractImplementsSpecs } from "../knowledge-graph/linker.js";
import type { GraphEdge, GraphFragment, GraphNode } from "../graph-db/types.js";
import type { ExtractOptions, ProjectFile, SupportedLanguage } from "./types.js";
import { tagsQuerySourceFor } from "./queries/index.js";
import { toPosixPath } from "./path-utils.js";
import { collectComments, findEnclosingFunction, qualifyFunctions, runTagQuery } from "./tag-query-engine.js";
import { measureErrorSpan, type FileParseHealth } from "./parse-health.js";

/**
 * Provenance stamp for every node this extractor produces (XSPEC-333 R1).
 * Lets the writer's merge policy tell a re-index of this same pipeline
 * (always allowed to overwrite) apart from a future different-provider write
 * (only allowed to overwrite when its confidence is strictly higher).
 */
const PROVIDER = "tree-sitter";

/**
 * Honest, per-resolution-tier confidence for a CALLS edge this extractor
 * writes (XSPEC-333 R3 OQ-4). `buildCallEdges` used to leave
 * `confidence`/`provider` unset on every CALLS edge it wrote (the REL
 * table's two columns stayed NULL — see `schema.ts`'s prior module doc).
 * That was not "no opinion", it was a real bug in the *merge* policy's
 * effect: `writer.ts`'s `shouldOverwrite` treats an existing NULL confidence
 * as "no signal to compare against" and refuses ANY cross-provider
 * overwrite in that case — so a second, more precise provider (e.g. SCIP)
 * could only ever fill a gap tree-sitter left empty, never upgrade an edge
 * tree-sitter already resolved, no matter how much higher its confidence
 * was. Confirmed end-to-end against a real SCIP index in
 * `test/scip-merge.test.ts` before this constant existed (that test used to
 * assert the block; it now asserts the upgrade — see that file's updated
 * module doc for why the old assertion was validating a limitation, not a
 * still-correct behaviour).
 *
 * The fix here is at the source, not the merge policy: `shouldOverwrite`
 * itself is untouched (still: same-provider always wins; different-provider
 * wins only with strictly higher confidence; NULL still means "no signal" —
 * see `test/writer-merge-policy.test.ts`'s dedicated regression test for
 * that exact NULL-still-blocks case, covering a legacy/pre-migration CALLS
 * row that predates this fix). Instead, this extractor now tells the truth
 * about its own resolution step's real reliability instead of leaving it
 * unscored.
 *
 * ## Why two tiers, not one flat number
 *
 * `collectExtraction`/`extractProject` resolve a call's callee by **bare
 * name only**, with NO type-awareness, overload disambiguation, or
 * import-graph following — but they do NOT throw away all distinctions:
 * they already tell apart, and already refuse to guess past, two
 * meaningfully different levels of evidence (see `extractProject`'s own
 * resolution-policy comment below):
 *
 *   - **same-file** (lexical shadowing: the callee's definition is a name in
 *     THIS file's own map) — the call site and its resolved target are
 *     textually in the same file, the strongest evidence this heuristic
 *     ever has for an actual calling relationship (comparable to how a real
 *     compiler resolves an unqualified in-scope name). Its one known
 *     failure mode is two same-named definitions in *different* scopes of
 *     one file colliding onto "last definition wins" (see this file's
 *     `names` map comment) — real, but narrow.
 *   - **cross-file-unique** (no same-file match; exactly one function
 *     project-wide has this bare name) — a fundamentally weaker signal:
 *     "there happens to be only one function named this string in the
 *     files we were given" says nothing about whether the call site's
 *     actual import/namespace path resolves there, or whether the real
 *     target lives outside the indexed file set entirely and this is a
 *     same-named coincidence. `docs/CROSS-FILE-COVERAGE.md`'s Open
 *     Questions document the mirror-image failure mode that already proves
 *     this tier is weaker in practice: 5 of 10 measured languages hit heavy
 *     *ambiguity* (>1 candidate, correctly left unresolved) from exactly
 *     the same bare-name blindness that, when it happens to find only one
 *     candidate instead of several, still carries the same underlying risk
 *     of an accidental name coincidence — the resolver just has no way to
 *     tell the difference from inside one project's file set. That doc's
 *     7.0%-74.1% numbers measure a different thing entirely — the
 *     *fraction of candidates the resolver manages to wire up at all*
 *     (recall over its own textual evidence), not the odds any one resolved
 *     edge points at the right target (precision) — so they are not used
 *     here as a literal conversion, only as corroborating evidence that
 *     this whole heuristic is crude enough that collapsing its two
 *     internally-distinguished tiers into one number would silently discard
 *     a real, already-computed signal for no reason.
 *
 * `CALLS_CONFIDENCE.same-file` (0.8) and `.cross-file-unique` (0.5) are both
 * hand-picked, not statistically derived (like SCIP's own `SCIP_CONFIDENCE
 * = 0.9`, also a deliberately-chosen constant, not a measured one) — but
 * both sit comfortably below 0.9 so a real semantic resolver can upgrade
 * either tier, and comfortably above 0/NULL so neither is ever mistaken for
 * "unscored".
 *
 * ## Function/Class node confidence is explicitly NOT touched here
 *
 * `FunctionNode.confidence` (`graph-db/types.ts`) is documented there as a
 * "SAGE confidence score" — `sage/writer.ts`'s `applyFeedback` mutates it
 * directly from real usage-feedback events (`SET n.confidence = ...`,
 * clamped to `[MIN_CONFIDENCE, MAX_CONFIDENCE]`), independently of anything
 * in this file. Tree-sitter's `confidence: 1` on a fresh Function node is
 * only SAGE's *starting* value, not a permanent claim of syntactic
 * certainty — an earlier draft of this comment argued the `1` was correct
 * because "tree-sitter's parser is unconditionally correct that a function
 * with this name exists here," which overstates it: that framing ignores
 * SAGE's independent write path entirely. The real, narrower reason this
 * constant does not touch Function-node confidence: (1) SCIP's inability to
 * exceed a tree-sitter Function node's `1` is a separate, already-documented
 * "confidence ceiling" limitation with its own passing test
 * (`test/scip-merge.test.ts`'s "confidence ceiling" case) and was explicitly
 * called out as out-of-scope for this fix; (2) Function-node confidence has
 * a second, independent consumer (SAGE's evolution loop) this fix has no
 * mandate to recalibrate — changing tree-sitter's initial stamp would be a
 * SAGE-calibration decision, not a CALLS-edge-merge decision, and deserves
 * its own deliberation. Note also `Class` nodes have NO `confidence` column
 * at all (`schema.ts`'s `Class` table, `ClassNode` in `types.ts`) — there is
 * nothing to leave alone or touch there in the first place.
 */

/**
 * How a CALLS edge's callee was resolved (XSPEC-333 R3 OQ-4) — drives which
 * {@link CALLS_CONFIDENCE} tier the edge is stamped with. See
 * `CALLS_CONFIDENCE`'s module doc (above) for what each tier means and why
 * they are scored differently.
 */
export type CallResolutionTier = "same-file" | "cross-file-unique";

const CALLS_CONFIDENCE: Record<CallResolutionTier, number> = {
  "same-file": 0.8,
  "cross-file-unique": 0.5,
};

/**
 * `.kt`/`.kts` → kotlin, `.rs` → rust, `.cpp`/`.cc`/`.cxx`/`.hpp`/`.h`/`.hh` →
 * cpp (XSPEC-333 R2c batch 2).
 *
 * C headers (`.h`) are mapped to the **C++** grammar, not a separate "c"
 * language this engine doesn't have — a deliberate, considered default, not
 * an oversight. A `.h` file cannot be reliably told apart from its language
 * by extension alone (plain C, C++, or a C header meant to be `extern "C"`-
 * wrapped from C++ all share it); `tree-sitter-cpp`'s grammar is a superset
 * of C for the overwhelming majority of real-world header syntax (struct/
 * function/typedef declarations, preprocessor directives), so parsing a pure-
 * C header with it typically still produces a usable, mostly-correct parse.
 * The narrow cases where this is NOT a perfect fit — legacy K&R-style
 * function definitions, C11 `_Generic`, or other C-only syntax the C++
 * grammar doesn't recognize — are a documented Open Question (see
 * queries/cpp.ts's module doc comment), not fixed here: this engine has no
 * `tree-sitter-c` grammar installed, and adding a whole separate language
 * purely to special-case `.h` is out of scope for this batch, whose task was
 * Kotlin/Rust/C++. `.hpp`/`.hh` (unambiguously C++-only extensions) share the
 * same mapping for consistency, not because they carry any of `.h`'s
 * ambiguity.
 *
 * `.rb` -> ruby, `.php` -> php, `.dart` -> dart (XSPEC-333 R2c batch 3, the
 * last mainstream-language batch). No extension-ambiguity questions like the
 * `.h` case above for any of the three: each extension is unambiguous.
 */
// Exported (XSPEC-333 R3 Java PoC) for the same reason as `parserFor` below:
// `scip-ingest.ts` needs the same file-extension -> language inference
// `ProjectFile.language` already falls back to, so `ScipSourceFile` can offer
// the identical optional-`language`-with-extension-fallback convention
// instead of a second, SCIP-only inference rule.
export function detectLanguage(filePath: string): SupportedLanguage {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return "typescript";
  }
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".rs")) return "rust";
  if (
    lower.endsWith(".cpp") ||
    lower.endsWith(".cc") ||
    lower.endsWith(".cxx") ||
    lower.endsWith(".hpp") ||
    lower.endsWith(".h") ||
    lower.endsWith(".hh")
  ) {
    return "cpp";
  }
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".dart")) return "dart";
  return "javascript";
}

/** Exported (XSPEC-333 R3 Java PoC) — see {@link parserFor}'s doc comment. */
export function languageFor(language: SupportedLanguage): Parser.Language {
  switch (language) {
    case "typescript":
      return TypeScript.typescript;
    case "tsx":
      return TypeScript.tsx;
    case "javascript":
      return JavaScript;
    case "csharp":
      return CSharp;
    case "python":
      return Python;
    case "go":
      return Go;
    case "java":
      return Java;
    case "kotlin":
      return Kotlin;
    case "rust":
      return Rust;
    case "cpp":
      return Cpp;
    case "ruby":
      return Ruby;
    case "php":
      return PhpModule.php;
    case "dart":
      return Dart;
  }
}

/**
 * Reuse one native Parser per language. tree-sitter parsers hold native
 * resources and have no `delete()`; allocating a fresh one per call leaks
 * handles and can keep a test worker process from exiting cleanly.
 */
const parserCache = new Map<SupportedLanguage, Parser>();

/**
 * Exported (XSPEC-333 R3 Java PoC) so a second SCIP-ingest language doesn't
 * have to duplicate this cache: `scip-ingest.ts`'s original C#-only PoC kept
 * its own single-language `csharpParser` cache rather than reusing this one,
 * which was fine when there was exactly one SCIP-backed language, but adding
 * Java meant either duplicating this whole grammar-lookup switch a second
 * time or reusing the one tree-sitter parser cache this module already
 * maintains for every language `egr index` supports — the latter is the
 * change made here, no behavior change for existing (non-SCIP) callers.
 */
export function parserFor(language: SupportedLanguage): Parser {
  let parser = parserCache.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(languageFor(language));
    parserCache.set(language, parser);
  }
  return parser;
}

/** An unresolved call: `from` (caller id) invoked something named `callee`. */
export interface RawCall {
  from: string;
  callee: string;
  /** File the call appears in (for same-file shadowing during resolution). */
  file: string;
}

/** Per-file extraction before call resolution. */
export interface Extraction {
  /** Module + Function + Class nodes (+ stub Spec nodes for IMPLEMENTS targets). */
  nodes: GraphNode[];
  /** DEFINES edges (Module → Function). */
  defines: GraphEdge[];
  /** IMPLEMENTS edges (Module → Spec) from `// implements XSPEC-NNN` comments. */
  implementsEdges: GraphEdge[];
  /** Unresolved call records. */
  rawCalls: RawCall[];
  /** This file's bare function name → id. */
  names: Map<string, string>;
  /**
   * Parse-health measurement for this file (XSPEC-334 R1b) — top-most
   * `ERROR`/`MISSING` node count, the extent they cover, and the total source
   * extent (all in tree-sitter's UTF-16 code-unit index; see
   * `parse-health.ts`). A clean parse is `{ errorNodes: 0, errorExtent: 0 }`.
   */
  errorNodes: number;
  errorExtent: number;
  sourceExtent: number;
}

/**
 * Extract a single file's nodes, DEFINES edges and *unresolved* call records
 * via a language's tag query ({@link runTagQuery}) plus range-containment
 * post-processing ({@link qualifyFunctions}, {@link findEnclosingFunction})
 * instead of a hand-written recursive walk (XSPEC-333 R2a). Call resolution
 * itself is deferred so it can be done intra-file ({@link extractCodeGraph})
 * or cross-file ({@link extractProject}).
 *
 * `opts.filePath` is normalized via {@link toPosixPath} (XSPEC-333 R3
 * follow-up) — this is the actual single choke point every Module/Function/
 * Class id in this codebase is built from, called by BOTH of this codebase's
 * id-generating entry points: `cli/walk.ts`'s `walkFiles` (already
 * normalized at its own source, so this is a harmless no-op re-application
 * for that caller) AND `mcp/server.ts`'s `index_code`/`index_docs` tools,
 * which take a caller-supplied `filePath`/`path` directly with no
 * `walkFiles` involved at all. Without normalizing here too, a Windows MCP
 * client indexing the same project a `walkFiles`-driven `egr index` CLI run
 * already indexed would mint a second, `\`-separated set of ids for the same
 * logical files instead of converging onto the same Module/Function/Class
 * nodes — the same silent-mismatch failure mode this whole fix exists to
 * close, just at a different entry point than the one the original `--scip`
 * bug report surfaced it through.
 *
 * @throws if the source cannot be parsed into a syntax tree.
 */
export function collectExtraction(source: string, opts: ExtractOptions): Extraction {
  const filePath = toPosixPath(opts.filePath);
  const language = opts.language ?? detectLanguage(filePath);
  const tree = parserFor(language).parse(source);

  // Parse-health (XSPEC-334 R1b): tree-sitter never throws on malformed
  // source — it recovers with ERROR/MISSING nodes and parses the rest — so
  // this is the one place that can see whether the parse was partial. Guarded
  // by `hasError` so a clean tree (the overwhelming majority) pays nothing.
  const { errorNodes, errorExtent } = tree.rootNode.hasError
    ? measureErrorSpan(tree.rootNode)
    : { errorNodes: 0, errorExtent: 0 };

  const moduleId = filePath;

  const nodes: GraphNode[] = [
    { label: "Module", id: moduleId, properties: { path: filePath } },
  ];
  const defines: GraphEdge[] = [];
  const names = new Map<string, string>();
  const rawCalls: RawCall[] = [];

  const { definitions, callSites } = runTagQuery(
    languageFor(language),
    language,
    tagsQuerySourceFor(language),
    tree.rootNode,
  );
  // Scope-qualification (not line numbers) keeps function ids unique — two
  // same-named functions in *different* scopes of one file no longer
  // collide — while staying stable across edits that shift line numbers
  // (incremental re-index updates in place). Two functions with the same
  // name in the *same* scope can't exist in valid JS/TS code — but this is
  // NOT true of every language on this engine: C# (XSPEC-333 R2b) allows
  // method overloading (same name, different parameter lists, same scope),
  // which this id scheme does not disambiguate by signature. Two overloads
  // collapse onto one qualified id (`file#Class.Method` for both), so
  // extractCodeGraph emits duplicate Function nodes sharing that id (and
  // duplicate DEFINES edges to it) rather than one node per overload — a
  // known, documented limitation (see test/csharp.test.ts's overload test),
  // not silently swallowed, and out of scope for R2b to fix (would need a
  // signature-aware id scheme change to this shared, language-agnostic
  // function, affecting every language on the engine, not just C#'s query
  // file).
  //
  // Go (XSPEC-333 R2c) has a related but *worse* collision: this engine's
  // scope-qualification is built entirely from byte-range containment (a
  // definition D is "inside" class C iff C's range contains D's), but a Go
  // method's receiver type is not lexically nested inside that type's
  // declaration at all — `func (c *Calculator) Compute()` sits as a
  // top-level sibling of `type Calculator struct {...}` elsewhere in the
  // file (verified against a real parse), so there is no containing node to
  // qualify against in the first place. queries/go.ts therefore does not
  // capture Go type/struct declarations as `@definition.class` at all (it
  // would give scope-qualification nothing to work with), and every Go
  // method's id is qualified by method name alone — so two *different*
  // receiver types' methods sharing a name (extremely common in Go: many
  // types each implement their own `String()`/`Close()`/`Error()`) collapse
  // onto the same id, more often in practice than C#'s same-scope overload
  // case. Documented in queries/go.ts's module doc as an Open Question, not
  // fixed here for the same shared-function reason as the C# case above.
  //
  // NOTE (XSPEC-333 R1, future work — not implemented here): this id format
  // (`file#qualified.name`) is a tree-sitter-provider convention. A future
  // non-tree-sitter provider (e.g. SCIP) will have its own native id scheme
  // that won't line up with this one; merging the two into one node per
  // real-world symbol will need an id-normalization layer at that point.
  const { functions, classes } = qualifyFunctions(filePath, definitions);

  for (const cls of classes) {
    nodes.push({
      label: "Class",
      id: `${filePath}#class:${cls.name}`,
      properties: { name: cls.name, file: filePath, provider: PROVIDER },
    });
  }

  for (const fn of functions) {
    nodes.push({
      label: "Function",
      id: fn.id,
      properties: {
        name: fn.name,
        file: filePath,
        start_line: fn.startLine,
        confidence: 1,
        provider: PROVIDER,
      },
    });
    defines.push({
      label: "DEFINES",
      fromLabel: "Module",
      from: moduleId,
      toLabel: "Function",
      to: fn.id,
    });
    // bare-name map for CALLS resolution (same-name in different scopes →
    // last definition wins; a documented intra-file resolution limitation).
    // `functions` is document-ordered (see runTagQuery), so this loop
    // reproduces the old walker's pre-order-DFS "last write wins" exactly.
    names.set(fn.name, fn.id);
  }

  for (const call of callSites) {
    // The old walker only recorded a call when it had a `currentFn` (i.e.
    // was already inside some function) — a call at module top level, or
    // inside a class body but outside any method, was silently dropped.
    // Finding no enclosing function reproduces that gate exactly.
    const enclosing = findEnclosingFunction(functions, call.node);
    if (enclosing) rawCalls.push({ from: enclosing.id, callee: call.name, file: filePath });
  }

  // `// implements XSPEC-NNN` / `/* implements SPEC-NNN */` — a file-level
  // declaration that this module implements a spec. Attached to the Module
  // (not the enclosing function): the convention annotates whole files.
  const moduleSpecs = new Set<string>();
  for (const text of collectComments(tree.rootNode)) {
    for (const specId of extractImplementsSpecs(text)) moduleSpecs.add(specId);
  }

  // Emit a stub Spec node (empty properties — never clobbers title/status/
  // confidence a later `index --docs` pass MERGEs onto the same id) so the
  // IMPLEMENTS edge's target always exists, then the Module→Spec edge itself.
  const implementsEdges: GraphEdge[] = [];
  for (const specId of moduleSpecs) {
    nodes.push({ label: "Spec", id: specId, properties: {} });
    implementsEdges.push({
      label: "IMPLEMENTS",
      fromLabel: "Module",
      from: moduleId,
      toLabel: "Spec",
      to: specId,
    });
  }

  return { nodes, defines, implementsEdges, rawCalls, names, errorNodes, errorExtent, sourceExtent: source.length };
}

/**
 * Turn resolved (from → to) call records into aggregated CALLS edges
 * (call_count per pair, self-recursion dropped). Each pair is stamped with
 * `CALLS_CONFIDENCE[tier]` (XSPEC-333 R3 OQ-4) — if the same (from, to) pair
 * is somehow reached via call sites of differing tiers (not expected in
 * practice: a given caller-file + callee-name combination resolves the same
 * way at every call site within one `collectExtraction`/`extractProject`
 * run, since the same-file map is checked first and is stable per file),
 * the LOWER-confidence tier wins, so an aggregated edge never overstates its
 * own reliability based on only its best call site.
 */
function buildCallEdges(resolved: Array<{ from: string; to: string; tier: CallResolutionTier }>): GraphEdge[] {
  const counts = new Map<string, { from: string; to: string; count: number; tier: CallResolutionTier }>();
  for (const { from, to, tier } of resolved) {
    if (!to || to === from) continue;
    const key = `${from} ${to}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      if (CALLS_CONFIDENCE[tier] < CALLS_CONFIDENCE[existing.tier]) existing.tier = tier;
    } else {
      counts.set(key, { from, to, count: 1, tier });
    }
  }
  return [...counts.values()].map(({ from, to, count, tier }) => ({
    label: "CALLS",
    fromLabel: "Function",
    from,
    toLabel: "Function",
    to,
    properties: { call_count: count, confidence: CALLS_CONFIDENCE[tier], provider: PROVIDER },
  }));
}

/**
 * Extract a {@link GraphFragment} from a single source file (CALLS resolved
 * within this file only). Stable Phase 2 API.
 *
 * @throws if the source cannot be parsed into a syntax tree.
 */
export function extractCodeGraph(source: string, opts: ExtractOptions): GraphFragment {
  const { nodes, defines, implementsEdges, rawCalls, names } = collectExtraction(source, opts);
  // Single-file extraction only ever resolves against this file's own name
  // map — every resolution here is by construction "same-file" (XSPEC-333
  // R3 OQ-4's higher-confidence tier; see CALLS_CONFIDENCE's module doc).
  const resolved = rawCalls
    .map((c) => ({ from: c.from, to: names.get(c.callee) ?? "", tier: "same-file" as const }))
    .filter((c) => c.to);
  return { nodes, edges: [...defines, ...buildCallEdges(resolved), ...implementsEdges] };
}

/** Stats for a cross-file extraction. */
export interface ProjectExtraction {
  fragment: GraphFragment;
  files: number;
  functions: number;
  classes: number;
  calls: number;
  /** IMPLEMENTS edges (Module → Spec) from `// implements` comments. */
  implements: number;
  /** Calls whose callee name matched >1 function across the repo (skipped). */
  ambiguous: number;
  /** Calls whose callee name matched no known function (skipped). */
  unresolved: number;
  /** Per-file raw parse-health, one entry per input file (XSPEC-334 R1b). */
  parseHealth: FileParseHealth[];
}

/**
 * Extract a {@link GraphFragment} from a whole repository, resolving CALLS
 * **across files**.
 *
 * Resolution policy per call (caller invokes a name): a same-file definition
 * wins (lexical shadowing); otherwise a globally unique definition of that
 * name; otherwise the call is dropped and counted as ambiguous/unresolved
 * (precision over recall).
 *
 * Per-file fault tolerance (XSPEC-334 R1a): each file's `collectExtraction`
 * runs in its own try/catch. A file that throws (rare — tree-sitter recovers
 * from malformed source without throwing; this catches genuine failures like
 * an unreadable-encoding edge case) is recorded as `failed` in `parseHealth`
 * and skipped, and every OTHER file is still indexed — a single bad file no
 * longer aborts the whole index run (which is what happened before: the old
 * `files.map(collectExtraction)` let one throw propagate out of the batch).
 */
export function extractProject(files: ProjectFile[]): ProjectExtraction {
  const parseHealth: FileParseHealth[] = [];
  // `extractions` and `okFiles` are kept parallel (same length/order): files
  // that threw are recorded in parseHealth and excluded from BOTH, so the
  // cross-file resolution below only ever sees successfully-parsed files.
  const extractions: Extraction[] = [];
  const okFiles: ProjectFile[] = [];
  for (const f of files) {
    const language = f.language ?? detectLanguage(f.path);
    try {
      const ex = collectExtraction(f.source, { filePath: f.path, language: f.language });
      extractions.push(ex);
      okFiles.push(f);
      parseHealth.push({
        path: toPosixPath(f.path),
        language,
        errorNodes: ex.errorNodes,
        errorExtent: ex.errorExtent,
        sourceExtent: ex.sourceExtent,
        functions: ex.nodes.reduce((n, node) => n + (node.label === "Function" ? 1 : 0), 0),
        classes: ex.nodes.reduce((n, node) => n + (node.label === "Class" ? 1 : 0), 0),
      });
    } catch (err) {
      // `failed` is best-effort truncated (not source text by design, but
      // `err.message` comes from arbitrary downstream code — truncating caps a
      // pathological message and shrinks the surface for any accidental source
      // leak; see FileParseHealth.failed's doc). `f.source.length` is guarded
      // because a non-string source (the very thing that made parse throw) has
      // no `.length` number.
      const message = err instanceof Error ? err.message : String(err);
      parseHealth.push({
        path: toPosixPath(f.path),
        language,
        errorNodes: 0,
        errorExtent: 0,
        sourceExtent: typeof f.source === "string" ? f.source.length : 0,
        functions: 0,
        classes: 0,
        failed: message.slice(0, 200),
      });
    }
  }

  const nodes: GraphNode[] = [];
  const defines: GraphEdge[] = [];
  const implementsEdges: GraphEdge[] = [];
  const localByFile = new Map<string, Map<string, string>>();
  const globalIndex = new Map<string, Set<string>>();

  for (let i = 0; i < extractions.length; i++) {
    const ex = extractions[i]!;
    const file = okFiles[i]!.path;
    nodes.push(...ex.nodes);
    defines.push(...ex.defines);
    implementsEdges.push(...ex.implementsEdges);
    // Key by the POSIX-normalized path: `RawCall.file` below is built from
    // `collectExtraction`'s already-normalized `filePath` (XSPEC-333 path
    // normalization), so a raw `okFiles[i].path` key (`src\a.ts` on Windows)
    // would never match the `src/a.ts` lookup — silently demoting every
    // same-file resolution to cross-file (wrong tier) or dropping it as
    // ambiguous. Pre-existing gap, fixed here while this loop is being touched.
    localByFile.set(toPosixPath(file), ex.names);
    for (const [name, id] of ex.names) {
      let ids = globalIndex.get(name);
      if (!ids) {
        ids = new Set();
        globalIndex.set(name, ids);
      }
      ids.add(id);
    }
  }

  const resolved: Array<{ from: string; to: string; tier: CallResolutionTier }> = [];
  let ambiguous = 0;
  let unresolved = 0;

  for (const ex of extractions) {
    for (const call of ex.rawCalls) {
      const local = localByFile.get(call.file)?.get(call.callee);
      if (local) {
        // Lexical shadowing: this caller's own file defines the name — if
        // the global branch below were reached instead, this file would
        // have had to be missing from its own local map, which it isn't.
        // So this branch is genuinely same-file (XSPEC-333 R3 OQ-4).
        resolved.push({ from: call.from, to: local, tier: "same-file" });
        continue;
      }
      const ids = globalIndex.get(call.callee);
      if (!ids || ids.size === 0) {
        unresolved += 1;
      } else if (ids.size === 1) {
        // No local match (checked above), so this unique project-wide name
        // is necessarily defined in some OTHER file — genuinely cross-file,
        // and the weaker of the two tiers (XSPEC-333 R3 OQ-4): see
        // CALLS_CONFIDENCE's module doc for why this carries materially
        // less evidence of a real calling relationship than a same-file
        // match.
        resolved.push({ from: call.from, to: [...ids][0]!, tier: "cross-file-unique" });
      } else {
        ambiguous += 1;
      }
    }
  }

  const calls = buildCallEdges(resolved);
  return {
    fragment: { nodes, edges: [...defines, ...calls, ...implementsEdges] },
    files: files.length,
    functions: nodes.filter((n) => n.label === "Function").length,
    classes: nodes.filter((n) => n.label === "Class").length,
    calls: calls.length,
    implements: implementsEdges.length,
    ambiguous,
    unresolved,
    parseHealth,
  };
}

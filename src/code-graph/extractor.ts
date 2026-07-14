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

import { extractImplementsSpecs } from "../knowledge-graph/linker.js";
import type { GraphEdge, GraphFragment, GraphNode } from "../graph-db/types.js";
import type { ExtractOptions, ProjectFile, SupportedLanguage } from "./types.js";
import { tagsQuerySourceFor } from "./queries/index.js";
import { collectComments, findEnclosingFunction, qualifyFunctions, runTagQuery } from "./tag-query-engine.js";

/**
 * Provenance stamp for every node this extractor produces (XSPEC-333 R1).
 * Lets the writer's merge policy tell a re-index of this same pipeline
 * (always allowed to overwrite) apart from a future different-provider write
 * (only allowed to overwrite when its confidence is strictly higher).
 */
const PROVIDER = "tree-sitter";

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
 */
function detectLanguage(filePath: string): SupportedLanguage {
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
  return "javascript";
}

function languageFor(language: SupportedLanguage): Parser.Language {
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
  }
}

/**
 * Reuse one native Parser per language. tree-sitter parsers hold native
 * resources and have no `delete()`; allocating a fresh one per call leaks
 * handles and can keep a test worker process from exiting cleanly.
 */
const parserCache = new Map<SupportedLanguage, Parser>();

function parserFor(language: SupportedLanguage): Parser {
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
}

/**
 * Extract a single file's nodes, DEFINES edges and *unresolved* call records
 * via a language's tag query ({@link runTagQuery}) plus range-containment
 * post-processing ({@link qualifyFunctions}, {@link findEnclosingFunction})
 * instead of a hand-written recursive walk (XSPEC-333 R2a). Call resolution
 * itself is deferred so it can be done intra-file ({@link extractCodeGraph})
 * or cross-file ({@link extractProject}).
 *
 * @throws if the source cannot be parsed into a syntax tree.
 */
export function collectExtraction(source: string, opts: ExtractOptions): Extraction {
  const language = opts.language ?? detectLanguage(opts.filePath);
  const tree = parserFor(language).parse(source);

  const filePath = opts.filePath;
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

  return { nodes, defines, implementsEdges, rawCalls, names };
}

/**
 * Turn resolved (from → to) call records into aggregated CALLS edges
 * (call_count per pair, self-recursion dropped).
 */
function buildCallEdges(resolved: Array<{ from: string; to: string }>): GraphEdge[] {
  const counts = new Map<string, { from: string; to: string; count: number }>();
  for (const { from, to } of resolved) {
    if (!to || to === from) continue;
    const key = `${from} ${to}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { from, to, count: 1 });
  }
  return [...counts.values()].map(({ from, to, count }) => ({
    label: "CALLS",
    fromLabel: "Function",
    from,
    toLabel: "Function",
    to,
    properties: { call_count: count },
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
  const resolved = rawCalls
    .map((c) => ({ from: c.from, to: names.get(c.callee) ?? "" }))
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
}

/**
 * Extract a {@link GraphFragment} from a whole repository, resolving CALLS
 * **across files**.
 *
 * Resolution policy per call (caller invokes a name): a same-file definition
 * wins (lexical shadowing); otherwise a globally unique definition of that
 * name; otherwise the call is dropped and counted as ambiguous/unresolved
 * (precision over recall).
 */
export function extractProject(files: ProjectFile[]): ProjectExtraction {
  const extractions = files.map((f) =>
    collectExtraction(f.source, { filePath: f.path, language: f.language }),
  );

  const nodes: GraphNode[] = [];
  const defines: GraphEdge[] = [];
  const implementsEdges: GraphEdge[] = [];
  const localByFile = new Map<string, Map<string, string>>();
  const globalIndex = new Map<string, Set<string>>();

  for (let i = 0; i < extractions.length; i++) {
    const ex = extractions[i]!;
    const file = files[i]!.path;
    nodes.push(...ex.nodes);
    defines.push(...ex.defines);
    implementsEdges.push(...ex.implementsEdges);
    localByFile.set(file, ex.names);
    for (const [name, id] of ex.names) {
      let ids = globalIndex.get(name);
      if (!ids) {
        ids = new Set();
        globalIndex.set(name, ids);
      }
      ids.add(id);
    }
  }

  const resolved: Array<{ from: string; to: string }> = [];
  let ambiguous = 0;
  let unresolved = 0;

  for (const ex of extractions) {
    for (const call of ex.rawCalls) {
      const local = localByFile.get(call.file)?.get(call.callee);
      if (local) {
        resolved.push({ from: call.from, to: local });
        continue;
      }
      const ids = globalIndex.get(call.callee);
      if (!ids || ids.size === 0) {
        unresolved += 1;
      } else if (ids.size === 1) {
        resolved.push({ from: call.from, to: [...ids][0]! });
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
  };
}

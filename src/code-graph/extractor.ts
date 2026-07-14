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

import { extractImplementsSpecs } from "../knowledge-graph/linker.js";
import type { GraphEdge, GraphFragment, GraphNode } from "../graph-db/types.js";
import type { ExtractOptions, ProjectFile, SupportedLanguage } from "./types.js";

/** tree-sitter node types that introduce a (potentially named) function. */
const FUNCTION_DECL_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
]);
const FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function", "function_expression"]);
const CLASS_TYPES = new Set(["class_declaration", "class"]);

/**
 * Provenance stamp for every node this extractor produces (XSPEC-333 R1).
 * Lets the writer's merge policy tell a re-index of this same pipeline
 * (always allowed to overwrite) apart from a future different-provider write
 * (only allowed to overwrite when its confidence is strictly higher).
 */
const PROVIDER = "tree-sitter";

function detectLanguage(filePath: string): SupportedLanguage {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
    return "typescript";
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

/** Resolve the bare callee name of a `call_expression`, or null if dynamic. */
function calleeName(callNode: Parser.SyntaxNode): string | null {
  const fn = callNode.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  // member_expression (e.g. `this.execute`, `console.log`) → property name
  if (fn.type === "member_expression") {
    return fn.childForFieldName("property")?.text ?? null;
  }
  return null;
}

/** A function discovered during the walk, before edges are resolved. */
interface DiscoveredFn {
  id: string;
  name: string;
  startLine: number;
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
 * Walk a single file's AST and collect nodes, DEFINES edges and *unresolved*
 * call records. Call resolution is deferred so it can be done intra-file
 * ({@link extractCodeGraph}) or cross-file ({@link extractProject}).
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
  /** Spec ids this file declares it implements (module-level, de-duplicated). */
  const moduleSpecs = new Set<string>();

  /**
   * Build a function's id, qualified by its enclosing scope chain (classes +
   * functions). Scope-qualification (not line numbers) keeps ids unique — two
   * same-named functions in *different* scopes of one file no longer collide —
   * while staying stable across edits that shift line numbers (incremental
   * re-index updates in place). Two functions with the same name in the *same*
   * scope can't exist in valid code.
   */
  function functionIdentity(
    node: Parser.SyntaxNode,
    scopeStack: string[],
  ): DiscoveredFn | null {
    let name: string | undefined;
    if (FUNCTION_DECL_TYPES.has(node.type) || node.type === "method_definition") {
      name = node.childForFieldName("name")?.text;
    } else if (FUNCTION_VALUE_TYPES.has(node.type) && node.parent?.type === "variable_declarator") {
      // arrow / function expression bound to a variable: `const log = (m) => ...`
      name = node.parent.childForFieldName("name")?.text;
    }
    if (!name) return null;
    const qualified = scopeStack.length > 0 ? `${scopeStack.join(".")}.${name}` : name;
    // NOTE (XSPEC-333 R1, future work — not implemented here): this id format
    // (`file#qualified.name`) is a tree-sitter-provider convention. A future
    // non-tree-sitter provider (e.g. SCIP) will have its own native id scheme
    // that won't line up with this one; merging the two into one node per
    // real-world symbol will need an id-normalization layer at that point.
    return { id: `${filePath}#${qualified}`, name, startLine: node.startPosition.row + 1 };
  }

  function visit(node: Parser.SyntaxNode, enclosingFnId: string | null, scopeStack: string[]): void {
    let currentFn = enclosingFnId;
    let pushedScope = false; // a node is either a class OR a function — at most one push

    // `// implements XSPEC-NNN` / `/* implements SPEC-NNN */` — a file-level
    // declaration that this module implements a spec. Attached to the Module
    // (not the enclosing function): the convention annotates whole files.
    if (node.type === "comment") {
      for (const specId of extractImplementsSpecs(node.text)) moduleSpecs.add(specId);
    }

    if (CLASS_TYPES.has(node.type)) {
      const className = node.childForFieldName("name")?.text;
      if (className) {
        nodes.push({
          label: "Class",
          id: `${filePath}#class:${className}`,
          properties: { name: className, file: filePath, provider: PROVIDER },
        });
        scopeStack.push(className);
        pushedScope = true;
      }
    }

    const fn = functionIdentity(node, scopeStack);
    if (fn) {
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
      names.set(fn.name, fn.id);
      currentFn = fn.id;
      scopeStack.push(fn.name); // qualify nested functions by this function
      pushedScope = true;
    }

    if (node.type === "call_expression" && currentFn) {
      const callee = calleeName(node);
      if (callee) rawCalls.push({ from: currentFn, callee, file: filePath });

      // A function passed by reference as a direct argument (e.g.
      // `app.register(pluginFn, opts)`) is a real usage edge that the
      // callee-of-this-call-expression check above misses entirely — see
      // module doc comment. Only bare identifiers directly in the argument
      // list count; identifiers nested in object/array literals are skipped.
      const args = node.childForFieldName("arguments");
      if (args) {
        for (let i = 0; i < args.namedChildCount; i++) {
          const arg = args.namedChild(i);
          if (arg?.type === "identifier") {
            rawCalls.push({ from: currentFn, callee: arg.text, file: filePath });
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child, currentFn, scopeStack);
    }

    if (pushedScope) scopeStack.pop();
  }

  visit(tree.rootNode, null, []);

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

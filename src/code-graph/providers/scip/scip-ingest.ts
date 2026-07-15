/**
 * SCIP → {@link GraphFragment} ingest converter (XSPEC-333 R3 PoC).
 *
 * Turns a parsed SCIP `Index` (see `scip-reader.ts`) plus the same C# source
 * files tree-sitter already indexes into a `provider: "scip"` fragment,
 * written through the existing, unmodified `writeFragment` (`graph-db/writer.ts`)
 * so R1's provenance-aware merge policy decides what actually lands in Kuzu.
 *
 * ## Why this reads tree-sitter's own AST instead of trusting SCIP ranges alone
 *
 * The original plan for this PoC was to resolve a call's *enclosing
 * function* purely from SCIP data, via `Occurrence.enclosing_range` (a field
 * the SCIP protobuf schema defines for exactly this purpose). **Verified
 * empirically against this PoC's own fixture `.scip` file: `scip-dotnet`
 * (v0.2.14) does not populate `enclosing_range` — every occurrence, definition
 * or reference, comes back with an empty array.** Its `range` field is a
 * single-line, name-token-level span (e.g. `[20, 23, 27]` for the 4 characters
 * `Main` in `static void Main(...)`), never the enclosing method body. Range
 * *containment* — the technique tree-sitter's own `findEnclosingFunction`
 * uses — is therefore unusable against SCIP data alone: a call's token-level
 * range is never "inside" a definition's token-level range (they don't
 * nest), so a naive containment check would silently resolve zero calls.
 *
 * The fix: since this PoC's ingest always has the *same source file* tree-sitter
 * already parses, `resolveEnclosingFunction`/`resolveDefinitionTarget` below
 * reuse tree-sitter's real parse (`runTagQuery` + `qualifyFunctions`, the same
 * functions `extractor.ts` itself calls) to get full-body node spans, and do
 * row-containment against *those*. This means:
 *
 *   - the CALLER side of every CALLS edge (which function is this reference
 *     occurrence physically inside?) is resolved via tree-sitter's own AST,
 *     not SCIP, for every call — SCIP contributes nothing here, because it
 *     structurally can't (this indexer never emits the range that would let
 *     it);
 *   - the CALLEE side (what does this bare name *really* resolve to?) is
 *     SCIP's actual contribution: a reference occurrence's `symbol` string is
 *     an opaque, guaranteed-correct join key back to that symbol's
 *     `Definition`-role occurrence (found anywhere in the index, in any
 *     file), which is then *itself* resolved to a tree-sitter Function/Class
 *     id via the same row-containment trick, this time in the *defining*
 *     file.
 *
 * A consequence worth being explicit about: **this ingest module cannot
 * function without a parallel tree-sitter parse of the same source** — it is
 * not a standalone SCIP-only pipeline. `scip-symbol.ts`'s pure string-based
 * `canonicalIdForSymbol` is the standalone alternative (see that file's
 * module doc for why it is not what this file actually uses for the merge):
 * it was deliberately kept as an independent, separately-tested code path
 * specifically so `test/scip-symbol.test.ts` could cross-check that its
 * output agrees with the ids this file derives via row-containment, on this
 * PoC's fixture project. They agree there; a real production adoption
 * spanning many files/languages would need far more of that cross-checking
 * before trusting either mechanism alone (see Open Questions in the R3 PoC
 * report for what this PoC did NOT verify: nested classes, partial classes,
 * local functions, constructors).
 *
 * ## Confidence / provider stamping
 *
 * Every `Function`/`Class` node and `CALLS` edge this module emits carries
 * `provider: "scip"`. `Function`/`CALLS` additionally carry
 * `confidence: SCIP_CONFIDENCE` (0.9) — chosen to be *lower* than 1.0 to stay
 * inside the `Function.confidence`'s documented `[0, 1]` range (see
 * `graph-db/types.ts`), even though this means it can in practice never
 * strictly exceed tree-sitter's own hardcoded `confidence: 1` on a
 * `Function` node it already created (`extractor.ts` stamps `confidence: 1`
 * unconditionally on every node it writes) — see `test/scip-merge.test.ts`'s
 * "confidence ceiling" test, and the R3 PoC report's Open Questions, for why
 * this is a real, now-empirically-confirmed consequence of R1's policy as
 * written, not a bug in this module.
 */

import Parser from "tree-sitter";
import CSharp from "tree-sitter-c-sharp";

import type { GraphEdge, GraphFragment, GraphNode } from "../../../graph-db/types.js";
import { tagsQuerySourceFor } from "../../queries/index.js";
import {
  qualifyFunctions,
  runTagQuery,
  type QualifiedClass,
  type QualifiedFunction,
} from "../../tag-query-engine.js";
import { classifySymbol, parseSymbol } from "./scip-symbol.js";
import { isDefinitionOccurrence, isLocalSymbol, type ScipIndex } from "./scip-reader.js";

export const SCIP_PROVIDER = "scip";
export const SCIP_CONFIDENCE = 0.9;

/** One source file this ingest run has access to, keyed the same way SCIP's `Document.relativePath` is. */
export interface ScipSourceFile {
  /** Must equal the corresponding `Document.relativePath` in the SCIP index. */
  relativePath: string;
  source: string;
}

interface FileScope {
  functions: QualifiedFunction[];
  classes: QualifiedClass[];
}

/**
 * Reuse one native Parser across every file/call in this module — same
 * rationale as `extractor.ts`'s own `parserCache`: tree-sitter parsers hold
 * native resources with no `delete()`, and allocating a fresh one per file
 * leaks handles that can crash a long-lived process (empirically hit while
 * building this PoC: the vitest worker process running `test/scip-merge.test.ts`
 * segfaulted between tests before this cache was added — multiple
 * uncached `new Parser()` calls across repeated `ingestScipIndex` calls in
 * one process, exactly the failure mode that comment warns about).
 */
let csharpParser: Parser | null = null;
function getCSharpParser(): Parser {
  if (!csharpParser) {
    csharpParser = new Parser();
    csharpParser.setLanguage(CSharp);
  }
  return csharpParser;
}

function buildFileScope(file: ScipSourceFile): FileScope {
  const tree = getCSharpParser().parse(file.source);
  const { definitions } = runTagQuery(CSharp, "csharp", tagsQuerySourceFor("csharp"), tree.rootNode);
  return qualifyFunctions(file.relativePath, definitions);
}

/** Smallest tree-sitter definition whose full node span contains 0-indexed `row`, or `null`. */
function smallestContaining<T extends { node: Parser.SyntaxNode }>(defs: T[], row: number): T | null {
  let best: T | null = null;
  let bestSize = Infinity;
  for (const def of defs) {
    const startRow = def.node.startPosition.row;
    const endRow = def.node.endPosition.row;
    if (startRow <= row && row <= endRow) {
      const size = endRow - startRow;
      if (size < bestSize) {
        best = def;
        bestSize = size;
      }
    }
  }
  return best;
}

export interface ScipIngestStats {
  filesParsed: number;
  /** Definition-role occurrences classified as function/class AND resolved to a tree-sitter node. */
  definitionsResolved: number;
  /** Same, but classified function/class with NO containing tree-sitter node found (unexpected; see Open Questions). */
  definitionsUnresolved: number;
  /** CALLS edges written (post call_count aggregation). */
  callsEmitted: number;
  /** Reference occurrences to a resolved function symbol, but no enclosing tree-sitter function found for the call site itself (e.g. a field initializer). */
  callsSkippedNoEnclosingCaller: number;
  /** Reference occurrences whose target symbol's own definition was never resolved (typically: external/library methods, out of this project's source set). */
  callsSkippedUnresolvedTarget: number;
}

export interface ScipIngestResult {
  fragment: GraphFragment;
  stats: ScipIngestStats;
}

/** Resolved identity of a SCIP symbol whose OWN definition maps onto a tree-sitter node. */
interface ResolvedDefinition {
  graphKind: "function" | "class";
  id: string;
  name: string;
  file: string;
  startLine?: number;
}

/**
 * Convert a parsed SCIP {@link ScipIndex} + the C# source files it was built
 * from into a `provider: "scip"` {@link GraphFragment}, ready for
 * `writeFragment`. See module doc for the row-containment design.
 */
export function ingestScipIndex(index: ScipIndex, files: ScipSourceFile[]): ScipIngestResult {
  const fileByPath = new Map(files.map((f) => [f.relativePath, f]));
  const scopeByPath = new Map<string, FileScope>();
  for (const f of files) scopeByPath.set(f.relativePath, buildFileScope(f));

  // Pass 1: first Definition-role occurrence per symbol, restricted to
  // symbols whose descriptor classifies as function/class (skips locals,
  // parameters, fields/properties, namespaces — see scip-symbol.ts).
  const definitionSite = new Map<string, { file: string; row: number; graphKind: "function" | "class" }>();
  for (const doc of index.documents) {
    if (!fileByPath.has(doc.relativePath)) continue;
    for (const occ of doc.occurrences) {
      if (!isDefinitionOccurrence(occ) || isLocalSymbol(occ.symbol)) continue;
      if (definitionSite.has(occ.symbol)) continue;
      const parsed = parseSymbol(occ.symbol);
      if (!parsed) continue;
      const graphKind = classifySymbol(parsed);
      if (graphKind === "other") continue;
      definitionSite.set(occ.symbol, { file: doc.relativePath, row: occ.range[0]!, graphKind });
    }
  }

  // Pass 2: resolve each definition site to a real tree-sitter node via
  // row-containment in its own file.
  const resolved = new Map<string, ResolvedDefinition>();
  let definitionsResolved = 0;
  let definitionsUnresolved = 0;
  for (const [symbol, site] of definitionSite) {
    const scope = scopeByPath.get(site.file);
    if (!scope) {
      definitionsUnresolved++;
      continue;
    }
    if (site.graphKind === "function") {
      const fn = smallestContaining(scope.functions, site.row);
      if (!fn) {
        definitionsUnresolved++;
        continue;
      }
      resolved.set(symbol, { graphKind: "function", id: fn.id, name: fn.name, file: site.file, startLine: fn.startLine });
      definitionsResolved++;
    } else {
      const cls = smallestContaining(scope.classes, site.row);
      if (!cls) {
        definitionsUnresolved++;
        continue;
      }
      resolved.set(symbol, { graphKind: "class", id: `${site.file}#class:${cls.name}`, name: cls.name, file: site.file });
      definitionsResolved++;
    }
  }

  // Pass 3: nodes (dedup by id — overloads of one method share one
  // tree-sitter id, exactly mirroring tree-sitter's own collapse).
  const nodesById = new Map<string, GraphNode>();
  const filesWithNodes = new Set<string>();
  for (const def of resolved.values()) {
    filesWithNodes.add(def.file);
    if (def.graphKind === "function") {
      nodesById.set(def.id, {
        label: "Function",
        id: def.id,
        properties: {
          name: def.name,
          file: def.file,
          start_line: def.startLine ?? 0,
          confidence: SCIP_CONFIDENCE,
          provider: SCIP_PROVIDER,
        },
      });
    } else {
      nodesById.set(def.id, {
        label: "Class",
        id: def.id,
        properties: { name: def.name, file: def.file, provider: SCIP_PROVIDER },
      });
    }
  }

  const moduleNodes: GraphNode[] = [...filesWithNodes].map((path) => ({
    label: "Module",
    id: path,
    properties: { path },
  }));
  const definesEdges: GraphEdge[] = [...nodesById.values()]
    .filter((n) => n.label === "Function")
    .map((n) => ({ label: "DEFINES", fromLabel: "Module", from: n.properties.file as string, toLabel: "Function", to: n.id }));

  // Pass 4: CALLS — reference occurrences to a resolved function symbol,
  // caller resolved via row-containment in the REFERENCING file.
  const callCounts = new Map<string, { from: string; to: string; count: number }>();
  let callsSkippedNoEnclosingCaller = 0;
  let callsSkippedUnresolvedTarget = 0;
  for (const doc of index.documents) {
    if (!fileByPath.has(doc.relativePath)) continue;
    const callerScope = scopeByPath.get(doc.relativePath);
    if (!callerScope) continue;
    for (const occ of doc.occurrences) {
      if (isDefinitionOccurrence(occ) || isLocalSymbol(occ.symbol)) continue;
      const target = resolved.get(occ.symbol);
      if (!target || target.graphKind !== "function") {
        // Either not a function-kind symbol (e.g. a `new Foo()` reference to
        // a Type, or a field/property access) or its own definition was
        // never resolved (typically: a library method outside this
        // project's source set, e.g. `Console.WriteLine`/`string.Trim`).
        if (target === undefined) {
          const parsed = parseSymbol(occ.symbol);
          if (parsed && classifySymbol(parsed) === "function") callsSkippedUnresolvedTarget++;
        }
        continue;
      }
      const caller = smallestContaining(callerScope.functions, occ.range[0]!);
      if (!caller) {
        callsSkippedNoEnclosingCaller++;
        continue;
      }
      if (caller.id === target.id) continue; // self-recursion, mirrors buildCallEdges
      const key = `${caller.id} ${target.id}`;
      const existing = callCounts.get(key);
      if (existing) existing.count += 1;
      else callCounts.set(key, { from: caller.id, to: target.id, count: 1 });
    }
  }

  const callsEdges: GraphEdge[] = [...callCounts.values()].map(({ from, to, count }) => ({
    label: "CALLS",
    fromLabel: "Function",
    from,
    toLabel: "Function",
    to,
    properties: { call_count: count, confidence: SCIP_CONFIDENCE, provider: SCIP_PROVIDER },
  }));

  return {
    fragment: {
      nodes: [...moduleNodes, ...nodesById.values()],
      edges: [...definesEdges, ...callsEdges],
    },
    stats: {
      filesParsed: files.length,
      definitionsResolved,
      definitionsUnresolved,
      callsEmitted: callsEdges.length,
      callsSkippedNoEnclosingCaller,
      callsSkippedUnresolvedTarget,
    },
  };
}

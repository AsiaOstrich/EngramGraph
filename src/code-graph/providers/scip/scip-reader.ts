/**
 * SCIP protobuf index reader (XSPEC-333 R3 PoC).
 *
 * Wraps `@c4312/scip` — the only usable SCIP protobuf binding found on npm
 * (searched for an official `@sourcegraph/scip` package; none is published.
 * `@c4312/scip` is a single-maintainer, unofficial package, but it is not a
 * hand-guessed reimplementation of the format: its own `package.json` build
 * script (`compile:fetch`) literally `curl`s the canonical
 * `scip.proto` from `github.com/sourcegraph/scip` and runs the official
 * `@bufbuild/protoc-gen-es` codegen against it, so the generated
 * `deserializeSCIP`/`Index`/`Document`/`Occurrence` shapes are schema-derived,
 * not guessed. Isolated behind this one file so a production adoption could
 * swap in a self-vendored `scip.proto` + `protobufjs` (or `@bufbuild/protobuf`)
 * build without touching any other module — see the module-level Open
 * Question in `scip-ingest.ts` for why that swap is recommended before any
 * non-PoC use.
 *
 * Only the fields this PoC's ingest converter actually needs are re-exported
 * (symbol, range, symbolRoles, relativePath) — this is deliberately not a
 * full SCIP reader (no `SymbolInformation.relationships`, no
 * `external_symbols`, no `Diagnostic`, etc.).
 */

import { readFileSync } from "node:fs";
import { deserializeSCIP, SymbolRole } from "@c4312/scip";
import type { Document, Index, Occurrence } from "@c4312/scip";

export type { Document as ScipDocument, Index as ScipIndex, Occurrence as ScipOccurrence };

/** Parse a `.scip` file (protobuf binary) into a typed {@link Index}. */
export function readScipIndex(path: string): Index {
  return deserializeSCIP(readFileSync(path));
}

/**
 * True when `occ` carries the `Definition` role bit.
 *
 * `symbolRoles` is a bitflag ({@link SymbolRole}); scip-dotnet in practice
 * only ever sets `Definition` (1) or leaves it 0 for a plain reference in
 * this PoC's sample — no occurrence was observed combining `Definition` with
 * another role bit — but the bitwise check is correct regardless.
 */
export function isDefinitionOccurrence(occ: Occurrence): boolean {
  return (occ.symbolRoles & SymbolRole.Definition) !== 0;
}

/**
 * `local N` symbols (scip-dotnet's convention for locals/parameters scoped to
 * one document, e.g. `"local 0"`) are never function/class definitions —
 * exclude them up front rather than let the descriptor parser reject them.
 */
export function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith("local ");
}

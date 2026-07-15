/**
 * SCIP protobuf index reader (XSPEC-333 R3 PoC; R3 Java PoC extension).
 *
 * Reads via a **self-vendored** `scip.proto` + generated TypeScript binding
 * (`scip_pb.ts`, alongside `scip.proto`, both in this directory) — the swap
 * this file's original module doc flagged as "recommended before any
 * non-PoC use" turned out not to be optional: it is the fix for a real gap
 * this Java PoC surfaced (see `scip_pb.ts`'s header comment for the full
 * empirical finding and the exact regen recipe). In short: the original C#
 * PoC's dependency, `@c4312/scip` (single-maintainer, frozen at npm 0.1.0
 * since 2024-08), was generated from a `scip.proto` snapshot that predates
 * the `typed_range`/`typed_enclosing_range` `oneof` fields modern indexers
 * (`scip-java` 0.13.1, this PoC's Java indexer) now emit *instead of* the
 * deprecated `repeated int32 range`/`enclosing_range` fields `scip-dotnet`
 * (the C# PoC's indexer) still happens to use — so the old binding silently
 * parsed every Java occurrence's position as an empty array. Regenerating
 * against the CURRENT `scip.proto` (same pipeline `@c4312/scip` itself used)
 * gives typed access to both encodings; {@link occurrenceRange} and
 * {@link occurrenceEnclosingRange} below normalize whichever one a given
 * indexer emits back to the plain `number[]` shape this module's callers
 * (`scip-ingest.ts`) already expect, so no other file needed to change.
 *
 * Only the fields this PoC's ingest converter actually needs are re-exported
 * (symbol, range, symbolRoles, relativePath) — this is deliberately not a
 * full SCIP reader (no `SymbolInformation.relationships`, no
 * `external_symbols`, no `Diagnostic`, etc.).
 */

import { readFileSync } from "node:fs";
import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema, SymbolRole } from "./scip_pb.js";
import type { Document, Index, Occurrence } from "./scip_pb.js";

export type { Document as ScipDocument, Index as ScipIndex, Occurrence as ScipOccurrence };

/** Parse a `.scip` file (protobuf binary) into a typed {@link Index}. */
export function readScipIndex(path: string): Index {
  return fromBinary(IndexSchema, readFileSync(path));
}

/**
 * Normalize an occurrence's position to the pre-existing `number[]` shape
 * (`[startLine, startChar, endChar]` for a single-line range, or
 * `[startLine, startChar, endLine, endChar]` for a multi-line one) — the
 * SAME shape the now-deprecated `repeated int32 range` field always used, so
 * every existing caller that reads `range[0]` for the start line keeps
 * working unchanged regardless of which encoding the source indexer emits.
 * Prefers the typed `oneof` (what current indexers emit) and falls back to
 * the deprecated field (what `scip-dotnet` still emits) — matching
 * `scip.proto`'s own documented precedence ("When both `typed_range` and the
 * deprecated `range` field are set, `typed_range` takes precedence").
 */
export function occurrenceRange(occ: Occurrence): number[] {
  switch (occ.typedRange.case) {
    case "singleLineRange": {
      const r = occ.typedRange.value;
      return [r.line, r.startCharacter, r.endCharacter];
    }
    case "multiLineRange": {
      const r = occ.typedRange.value;
      return [r.startLine, r.startCharacter, r.endLine, r.endCharacter];
    }
    default:
      return occ.range;
  }
}

/** Same normalization as {@link occurrenceRange}, for the enclosing-range pair of fields. */
export function occurrenceEnclosingRange(occ: Occurrence): number[] {
  switch (occ.typedEnclosingRange.case) {
    case "singleLineEnclosingRange": {
      const r = occ.typedEnclosingRange.value;
      return [r.line, r.startCharacter, r.endCharacter];
    }
    case "multiLineEnclosingRange": {
      const r = occ.typedEnclosingRange.value;
      return [r.startLine, r.startCharacter, r.endLine, r.endCharacter];
    }
    default:
      return occ.enclosingRange;
  }
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

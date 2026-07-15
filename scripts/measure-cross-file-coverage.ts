/**
 * Cross-file CALLS resolution coverage measurement (XSPEC-333 R4).
 *
 * Not a build artifact, not shipped in `dist` — a one-off/repeatable
 * measurement tool run directly against `src/` with `tsx`, in the same
 * spirit as `scripts/health-check.mjs` (which runs against `dist`). This one
 * needs `collectExtraction`, which is an internal `extractor.ts` export not
 * re-exported from the public `code-graph/index.ts` surface, hence the
 * `../src/...` import instead of `../dist/index.js`.
 *
 * ## What this measures
 *
 * `extractProject` (src/code-graph/extractor.ts) resolves a call site's
 * callee name to a specific `Function` node using a bare-name heuristic:
 * same-file match wins, else a globally-unique match across the whole
 * project, else the call is dropped (ambiguous or unresolved). This script
 * asks, per *defined symbol* (`Function` node), not per raw call: "of the
 * symbols that some OTHER file's source textually calls by name, what
 * fraction actually ended up with a resolved cross-file `CALLS` edge into
 * them?"
 *
 * That framing deliberately separates two things that must not be conflated
 * into one denominator:
 *
 *   - A symbol with **zero** textual call sites naming it from any other
 *     file (entry points, `main`, event-handler callbacks the runtime
 *     invokes, public API surface only consumed by external code not in this
 *     corpus, dead code) can *never* get a cross-file edge no matter how
 *     good the resolver is. Counting it in the denominator would silently
 *     and systematically deflate the score by a repo-composition artifact
 *     (how many "leaf" symbols happen to exist), not a resolver limitation.
 *     These are excluded from the denominator and reported separately.
 *
 *   - A symbol with at least one such textual reference is a genuine
 *     resolution *opportunity*. Whether the tool actually produced a
 *     cross-file `CALLS` edge into it is the real coverage question.
 *
 * ## Method
 *
 * 1. Parse every file once via `collectExtraction` (per-file, unresolved
 *    `rawCalls` + bare-name map) — this is the same per-file step
 *    `extractProject` runs internally, just not thrown away afterward.
 * 2. Also run the real, unmodified `extractProject` over the same file set
 *    to get the actual resolved `CALLS` edges a consumer would see.
 * 3. Build `calleeOccurrences`: bare callee name -> set of files containing
 *    at least one call site naming it (from step 1's `rawCalls`, ACROSS all
 *    files, deliberately ignoring same-file shadowing here — this set is
 *    "textual evidence a name is invoked somewhere else", not a resolution
 *    replay).
 * 4. For every `Function` node `s` (id encodes `file#qualified.name`, so the
 *    defining file is recovered by splitting on the first `#`):
 *      - `otherFiles = calleeOccurrences.get(s.name) \ {s.file}`
 *      - if `otherFiles` is empty -> excluded, tallied as "no cross-file
 *        textual evidence" (an entry-point-shaped symbol for this corpus).
 *      - else -> denominator += 1; numerator += 1 iff the real
 *        `extractProject` result contains >= 1 `CALLS` edge with
 *        `to === s.id` whose `from` node's file (same id-splitting trick) is
 *        different from `s.file`.
 * 5. Coverage % = numerator / denominator (undefined / reported as "n/a"
 *    when denominator is 0 — should not happen for any real repo but a
 *    degenerate single-file corpus could hit it).
 *
 * This is intentionally NOT a ground-truth/oracle-based recall measurement
 * (no independently-labeled "correct call graph" exists for these repos) —
 * it measures the heuristic against the textual evidence its own inputs
 * contain, which is the same signal the resolver itself works from. A
 * shadowed cross-file call (caller's file has its own same-named local
 * function, so the same-file-wins rule resolves there instead) will show up
 * here as a coverage miss for the *would-be* target symbol — that is a real,
 * documented, intentional precision-over-recall tradeoff of the resolver
 * (see extractor.ts's module doc), not a bug, but it is included in the
 * score because it IS a real cross-file relationship the tool did not wire
 * up. Where it materially affects a language's number, that is called out in
 * the results write-up rather than filtered out of the score.
 *
 * Usage:
 *   npx tsx scripts/measure-cross-file-coverage.ts <language> <dir> [--json]
 *
 * <language> must be one of SupportedLanguage's string values (extractor.ts
 * `detectLanguage` mapping is duplicated here as EXT_TO_LANG so only files
 * matching that language's extensions are pulled from a possibly
 * mixed-language directory tree; anything else under <dir> is ignored, not
 * an error).
 */

import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { collectExtraction, extractProject } from "../src/code-graph/extractor.js";
import type { ProjectFile, SupportedLanguage } from "../src/code-graph/types.js";

const EXT_TO_LANG: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".cs": "csharp",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rs": "rust",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".h": "cpp",
  ".hh": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".dart": "dart",
};

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "target", "build", "dist", "bin", "obj"]);

function walk(dir: string, lang: SupportedLanguage, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), lang, out);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (EXT_TO_LANG[ext] === lang) out.push(join(dir, entry.name));
    }
  }
  return out;
}

interface CoverageResult {
  language: SupportedLanguage;
  dir: string;
  files: number;
  functions: number;
  classes: number;
  totalCallsResolved: number;
  ambiguous: number;
  unresolved: number;
  symbolsWithNoCrossFileEvidence: number;
  denominator: number;
  numerator: number;
  coveragePercent: number | null;
  misses: Array<{ id: string; name: string; file: string; otherFiles: string[] }>;
}

function fileOf(id: string): string {
  const i = id.indexOf("#");
  return i === -1 ? id : id.slice(0, i);
}

export function measure(dir: string, lang: SupportedLanguage): CoverageResult {
  const paths = walk(dir, lang);
  const files: ProjectFile[] = paths.map((p) => ({
    path: relative(dir, p),
    source: readFileSync(p, "utf8"),
    language: lang,
  }));

  const perFile = files.map((f) => ({
    file: f.path,
    ...collectExtraction(f.source, { filePath: f.path, language: lang }),
  }));

  const project = extractProject(files);

  // calleeOccurrences: bare callee name -> set of files with >=1 call site
  // naming it (textual evidence, pre-resolution, no shadow-awareness).
  const calleeOccurrences = new Map<string, Set<string>>();
  for (const ex of perFile) {
    for (const call of ex.rawCalls) {
      let set = calleeOccurrences.get(call.callee);
      if (!set) {
        set = new Set();
        calleeOccurrences.set(call.callee, set);
      }
      set.add(ex.file);
    }
  }

  // incoming CALLS edges by target symbol id, with caller file precomputed.
  const incomingByTarget = new Map<string, string[]>();
  for (const edge of project.fragment.edges) {
    if (edge.label !== "CALLS") continue;
    let froms = incomingByTarget.get(edge.to);
    if (!froms) {
      froms = [];
      incomingByTarget.set(edge.to, froms);
    }
    froms.push(fileOf(edge.from));
  }

  const functionNodes = project.fragment.nodes.filter((n) => n.label === "Function");

  let symbolsWithNoCrossFileEvidence = 0;
  let denominator = 0;
  let numerator = 0;
  const misses: CoverageResult["misses"] = [];

  for (const node of functionNodes) {
    const name = String(node.properties.name);
    const file = fileOf(node.id);
    const occurrences = calleeOccurrences.get(name);
    const otherFiles = occurrences ? [...occurrences].filter((f) => f !== file) : [];

    if (otherFiles.length === 0) {
      symbolsWithNoCrossFileEvidence += 1;
      continue;
    }

    denominator += 1;
    const froms = incomingByTarget.get(node.id) ?? [];
    const hasCrossFileEdge = froms.some((f) => f !== file);
    if (hasCrossFileEdge) {
      numerator += 1;
    } else {
      misses.push({ id: node.id, name, file, otherFiles });
    }
  }

  return {
    language: lang,
    dir,
    files: files.length,
    functions: functionNodes.length,
    classes: project.classes,
    totalCallsResolved: project.calls,
    ambiguous: project.ambiguous,
    unresolved: project.unresolved,
    symbolsWithNoCrossFileEvidence,
    denominator,
    numerator,
    coveragePercent: denominator === 0 ? null : (numerator / denominator) * 100,
    misses,
  };
}

function main() {
  const [, , langArg, dirArg, ...rest] = process.argv;
  if (!langArg || !dirArg) {
    console.error("Usage: npx tsx scripts/measure-cross-file-coverage.ts <language> <dir> [--json]");
    process.exit(1);
  }
  const lang = langArg as SupportedLanguage;
  const result = measure(dirArg, lang);

  if (rest.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`language:                    ${result.language}`);
  console.log(`dir:                         ${result.dir}`);
  console.log(`files parsed:                ${result.files}`);
  console.log(`Function symbols:            ${result.functions}`);
  console.log(`Class symbols:               ${result.classes}`);
  console.log(`resolved CALLS edges:        ${result.totalCallsResolved}`);
  console.log(`  (project-level ambiguous:  ${result.ambiguous}, unresolved: ${result.unresolved})`);
  console.log(`symbols w/ no x-file evidence (excluded): ${result.symbolsWithNoCrossFileEvidence}`);
  console.log(`denominator (x-file candidates):          ${result.denominator}`);
  console.log(`numerator (resolved):                      ${result.numerator}`);
  console.log(
    `coverage:                                   ${
      result.coveragePercent === null ? "n/a" : result.coveragePercent.toFixed(1) + "%"
    }`,
  );
  if (result.misses.length > 0) {
    console.log(`\nmisses (first 15 of ${result.misses.length}):`);
    for (const m of result.misses.slice(0, 15)) {
      console.log(`  - ${m.name} (${m.file}) — also referenced from: ${m.otherFiles.join(", ")}`);
    }
  }
}

main();

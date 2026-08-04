/**
 * CodeGraph module types.
 *
 * The extractor turns source files into a provider-agnostic
 * {@link GraphFragment} (defined in graph-db/types); these types describe the
 * extractor/indexer surface.
 */

import type { FileParseHealth } from "./parse-health.js";
import type { LanguageId } from "../../language-support.js";

/**
 * Languages the extractor can parse with the bundled tree-sitter grammars.
 *
 * Re-exported from the language registry rather than declared here
 * (// implements XSPEC-365 R4). The registry is the single source of truth for
 * which languages exist, which package backs each one, and which platforms
 * that package ships a prebuilt binary for — the install-time preflight, the
 * runtime availability check, and the docs table all read the same data.
 * Declaring the union a second time here is exactly the drift this arrangement
 * exists to prevent.
 *
 * Note this type says which languages the extractor *knows about*, which is
 * not the same as which ones are usable in a given process: a grammar whose
 * native binary failed to build is a member of this union but absent from
 * {@link availableLanguages} at runtime. See extractor.ts's `languageFor`.
 */
export type SupportedLanguage = LanguageId;

export interface ExtractOptions {
  /**
   * Path of the file being parsed. Used as the Module id and as the prefix of
   * every Function/Class id, so it should be stable across re-indexing
   * (a repo-relative path is recommended).
   */
  filePath: string;
  /**
   * Override language detection. When omitted it is inferred from the
   * `filePath` extension (.ts/.mts/.cts → typescript, .tsx → tsx,
   * .js/.jsx/.mjs/.cjs → javascript, .cs → csharp, .py → python, .go → go,
   * .java → java, .kt/.kts → kotlin, .rs → rust, .cpp/.cc/.cxx/.hpp/.h/.hh →
   * cpp, .rb → ruby, .php → php, .dart → dart — see extractor.ts's
   * `detectLanguage` doc comment for why C headers are mapped to the C++
   * grammar, not a separate "c" language).
   */
  language?: SupportedLanguage;
}

/** Summary of what {@link indexFile} wrote to the graph. */
export interface IndexResult {
  /** Module node id (the file path). */
  module: string;
  functions: number;
  classes: number;
  /** Number of resolved CALLS edges written. */
  calls: number;
}

/** One source file in a repository-level index. */
export interface ProjectFile {
  /** Repo-relative path; used as Module id + Function/Class id prefix. */
  path: string;
  source: string;
  /** Override language detection (inferred from `path` extension when omitted). */
  language?: SupportedLanguage;
}

/**
 * One language that could not be indexed in this run because its grammar is
 * not available in this installation. // implements XSPEC-365 R2
 *
 * Deliberately *not* folded into parse-health's `failed` bucket. A file that
 * failed to parse is a file the engine looked at and could not understand —
 * a blindspot worth investigating in the source. A file skipped here was never
 * looked at, because the grammar for its language isn't built on this machine.
 * Same visible symptom ("this file isn't in the graph"), completely different
 * fix, so reporting them through one channel would send people to read source
 * code when what they need is a toolchain.
 */
export interface SkippedLanguage {
  language: SupportedLanguage;
  /** Human-readable name, e.g. `"Dart"`. */
  label: string;
  /** npm package that provides the missing grammar. */
  package: string;
  /** First line of the underlying load error. */
  reason: string;
  /** How many files in this run were skipped for this reason. */
  files: number;
}

/** Summary of what {@link indexProject} wrote (cross-file CALLS resolution). */
export interface ProjectIndexResult {
  files: number;
  functions: number;
  classes: number;
  /** Resolved CALLS edges (includes cross-file). */
  calls: number;
  /** IMPLEMENTS edges (Module → Spec) from `// implements` comments. */
  implements: number;
  /** Calls whose callee name matched >1 function across the repo (skipped). */
  ambiguous: number;
  /** Calls whose callee name matched no known function (skipped). */
  unresolved: number;
  /** Per-file raw parse-health, one entry per input file (XSPEC-334 R1b). */
  parseHealth: FileParseHealth[];
  /** Languages skipped for want of a grammar (XSPEC-365 R2). Empty is normal. */
  skippedLanguages: SkippedLanguage[];
}

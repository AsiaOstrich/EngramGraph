/**
 * CodeGraph module types.
 *
 * The extractor turns source files into a provider-agnostic
 * {@link GraphFragment} (defined in graph-db/types); these types describe the
 * extractor/indexer surface.
 */

import type { FileParseHealth } from "./parse-health.js";

/** Languages the extractor can parse with the bundled tree-sitter grammars. */
export type SupportedLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "csharp"
  | "python"
  | "go"
  | "java"
  | "kotlin"
  | "rust"
  | "cpp"
  | "ruby"
  | "php"
  | "dart";

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
}

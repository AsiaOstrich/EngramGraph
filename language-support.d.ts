/**
 * Types for `language-support.js`. // implements XSPEC-365 R4
 *
 * The runtime data lives in plain JavaScript because `preinstall.js` has to
 * read it before anything is compiled — see that file's header for why. This
 * declaration is what lets the TypeScript sources consume the same data
 * without restating the language list.
 *
 * `LanguageId` is the single TypeScript-side enumeration of supported
 * languages: `src/code-graph/types.ts` re-exports it as `SupportedLanguage`
 * rather than declaring its own union. `test/language-support.test.ts` binds
 * this union to the runtime `GRAMMARS` array in both directions, so a language
 * added to one and forgotten in the other fails the build rather than becoming
 * a silent gap.
 */

/** `${process.platform}-${process.arch}`, e.g. `"darwin-arm64"`. */
export type Platform =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-arm64"
  | "win32-x64";

/** Every language the extractor can parse. */
export type LanguageId =
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

export interface Grammar {
  language: LanguageId;
  /** Human-readable name, used in docs tables and install-time messages. */
  label: string;
  /** Extensions `detectLanguage()` maps to this language. */
  extensions: readonly string[];
  /** npm package providing the tree-sitter grammar. */
  package: string;
  /**
   * Property to read off the package's export when it bundles more than one
   * grammar (`tree-sitter-typescript` → `{ typescript, tsx }`,
   * `tree-sitter-php` → `{ php, php_only }`). Omitted when the package's
   * export *is* the grammar, which is the common case.
   */
  exportKey?: string;
  /** Platforms this package ships a prebuilt binary for. */
  prebuilds: readonly string[];
}

export interface NativeDependency {
  package: string;
  /** What it does, for the docs table. */
  role: string;
  prebuilds: readonly string[];
}

/** A native dependency that will be compiled from source on some platform. */
export interface CompiledFromSource {
  package: string;
  kind: "grammar" | "runtime";
  /** Labels of the languages lost if this package fails to build. */
  languages: string[];
  /** Present for `kind: "runtime"` entries. */
  role?: string;
}

/** A known, currently-harmless problem with a native dependency. */
export interface KnownIssue {
  id: string;
  package: string;
  symptom: string;
  severity: "warning-only";
  action: string;
  /** What has to happen for this to stop being an observation. */
  resolveWhen: string;
  firstSeen: string;
}

export const ALL_PLATFORMS: readonly Platform[];
export const KNOWN_ISSUES: readonly KnownIssue[];
export const GRAMMARS: readonly Grammar[];
export const OTHER_NATIVE_DEPENDENCIES: readonly NativeDependency[];

export function currentPlatform(): string;
export function compiledFromSourceOn(platform?: string): CompiledFromSource[];

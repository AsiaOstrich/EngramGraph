/**
 * Lazy, failable loading of the tree-sitter grammars.
 * // implements XSPEC-365 R2
 *
 * **What changed and why.** `extractor.ts` used to import all thirteen
 * grammars statically at the top of the module. Two consequences followed from
 * that one line each:
 *
 *   - Every grammar was loaded on any use of the extractor, including the
 *     twelve you weren't indexing.
 *   - A single grammar whose native binary was missing took down module
 *     initialization, so the failure was not "Dart is unavailable" but
 *     "`egr` cannot index anything at all". `@vokturz/tree-sitter-dart` ships
 *     a prebuilt binary for `linux-x64` only, so that was the normal outcome
 *     of installing on any other platform without a C/C++ toolchain.
 *
 * This module loads each grammar on first use, records the failure instead of
 * propagating it, and lets the rest of the engine carry on with the languages
 * that did load.
 *
 * **Loading is not the same as working, so both are checked.** A grammar can
 * `require()` cleanly and still be unusable: `grammars.d.ts` documents three
 * separate packages (`tree-sitter-c-sharp@0.23.5`, `@sengac/tree-sitter-dart`,
 * `@driftlog/tree-sitter-dart`) that import fine and then throw inside
 * `Parser.setLanguage` because they were generated against a different
 * language ABI than this repo's pinned `tree-sitter@0.22.4` core. So the probe
 * here is not "did `require` return something" — it is "did a real `Parser`
 * accept it". Anything short of that would report a grammar as available and
 * fail at the first file.
 *
 * **Why `createRequire` rather than `await import()`.** Keeping the load
 * synchronous means `parserFor`/`languageFor` keep their existing signatures
 * and no caller has to become async — the alternative would have turned
 * extractor initialization into an async operation and rippled through the
 * CLI and MCP entry points for no benefit. `parse-manifest.ts` already uses
 * the same mechanism to read grammar versions.
 */

import { createRequire } from "node:module";
import Parser from "tree-sitter";

import { GRAMMARS } from "../../language-support.js";
import type { Grammar } from "../../language-support.js";
import type { SupportedLanguage } from "./types.js";

const require = createRequire(import.meta.url);

const BY_LANGUAGE = new Map<SupportedLanguage, Grammar>(
  GRAMMARS.map((g) => [g.language, g]),
);

/**
 * Thrown when a language's grammar could not be loaded (or loaded but failed
 * to bind to a parser). Distinct from a parse failure: the file is fine, the
 * engine simply has no grammar for it in this installation. Callers use the
 * type to tell "this file is malformed" apart from "this language is not
 * installed", which are different problems with different fixes.
 */
export class GrammarUnavailableError extends Error {
  constructor(
    readonly language: SupportedLanguage,
    readonly grammarPackage: string,
    readonly cause: string,
  ) {
    super(
      `${language} support is not enabled in this installation: ` +
        `${grammarPackage} could not be loaded (${cause})`,
    );
    this.name = "GrammarUnavailableError";
  }
}

interface LoadedGrammar {
  ok: true;
  language: Parser.Language;
  parser: Parser;
}
interface FailedGrammar {
  ok: false;
  error: GrammarUnavailableError;
}
type LoadResult = LoadedGrammar | FailedGrammar;

/** Memoized per language — a load is attempted at most once per process. */
const cache = new Map<SupportedLanguage, LoadResult>();

function describe(err: unknown): string {
  if (err instanceof Error) {
    // Native loader errors are long and path-heavy; the first line carries the
    // signal ("Cannot find module", "was compiled against a different Node
    // version", the dlopen text).
    return (err.message.split("\n")[0] ?? err.message).slice(0, 300);
  }
  return String(err).slice(0, 300);
}

function load(language: SupportedLanguage): LoadResult {
  const cached = cache.get(language);
  if (cached) return cached;

  const grammar = BY_LANGUAGE.get(language);
  if (!grammar) {
    // Unreachable for a well-formed SupportedLanguage — the registry and the
    // union are bound to each other by test/language-support.test.ts — but a
    // caller reaching here with a hand-built string gets a real error rather
    // than `undefined` flowing onward.
    const result: LoadResult = {
      ok: false,
      error: new GrammarUnavailableError(
        language,
        "(unknown)",
        "no grammar is registered for this language",
      ),
    };
    cache.set(language, result);
    return result;
  }

  let result: LoadResult;
  try {
    const mod: unknown = require(grammar.package);
    const raw = grammar.exportKey
      ? (mod as Record<string, unknown>)[grammar.exportKey]
      : mod;
    if (raw === undefined || raw === null) {
      throw new Error(
        grammar.exportKey
          ? `package loaded but has no "${grammar.exportKey}" export`
          : "package loaded but exported nothing",
      );
    }
    // The real probe: a Parser has to accept it. See this module's header for
    // the three packages that pass `require` and fail here.
    const parser = new Parser();
    const parserLanguage = raw as Parser.Language;
    parser.setLanguage(parserLanguage);
    result = { ok: true, language: parserLanguage, parser };
  } catch (err) {
    result = {
      ok: false,
      error: new GrammarUnavailableError(
        language,
        grammar.package,
        describe(err),
      ),
    };
  }

  cache.set(language, result);
  return result;
}

/** Human-readable name for a language, e.g. `"C#"` for `"csharp"`. */
export function labelFor(language: SupportedLanguage): string {
  return BY_LANGUAGE.get(language)?.label ?? language;
}

/** Whether `language` can actually be parsed in this installation. */
export function isLanguageAvailable(language: SupportedLanguage): boolean {
  return load(language).ok;
}

/**
 * The tree-sitter `Language` for `language`.
 *
 * @throws {GrammarUnavailableError} if the grammar is missing or unusable.
 */
export function languageFor(language: SupportedLanguage): Parser.Language {
  const result = load(language);
  if (!result.ok) throw result.error;
  return result.language;
}

/**
 * A cached `Parser` bound to `language`.
 *
 * One parser per language, reused: tree-sitter parsers hold native resources
 * and have no `delete()`, so allocating a fresh one per call leaks handles and
 * can keep a test worker process from exiting cleanly.
 *
 * @throws {GrammarUnavailableError} if the grammar is missing or unusable.
 */
export function parserFor(language: SupportedLanguage): Parser {
  const result = load(language);
  if (!result.ok) throw result.error;
  return result.parser;
}

/** One grammar that failed to load, and why. */
export interface UnavailableGrammar {
  language: SupportedLanguage;
  /** Human-readable name, for messages. */
  label: string;
  package: string;
  reason: string;
}

/**
 * Every language whose grammar cannot be used in this installation.
 *
 * This *attempts to load all thirteen grammars* — it is the one operation here
 * that is not lazy, because "which languages are unavailable" cannot be
 * answered without trying. Intended for the CLI's startup notice and
 * diagnostics, not for hot paths. Results are memoized, so calling it more
 * than once per process is free.
 */
export function unavailableGrammars(): UnavailableGrammar[] {
  const out: UnavailableGrammar[] = [];
  for (const grammar of GRAMMARS) {
    const result = load(grammar.language);
    if (!result.ok) {
      out.push({
        language: grammar.language,
        label: grammar.label,
        package: grammar.package,
        reason: result.error.cause,
      });
    }
  }
  return out;
}

/** Every language whose grammar loaded and bound to a parser successfully. */
export function availableLanguages(): SupportedLanguage[] {
  return GRAMMARS.filter((g) => load(g.language).ok).map((g) => g.language);
}

/**
 * Bash tag query (tree-sitter Query API, S-expression syntax) — XSPEC-414
 * R4. Same capture-naming convention as the rest of this batch
 * (`@definition.function`, `@name`, `@reference.call`, `@reference.import`
 * — see `queries/c.ts`'s module doc comment for `@reference.import`'s
 * general shape). Node-type names below were read from `tree-sitter-bash`'s
 * `src/node-types.json` (0.23.3 — see `language-support.js`'s doc comment
 * for why this version is pinned) and verified against real parses via
 * `Parser.Query.matches`, not guessed.
 *
 * -- function definitions -----------------------------------------------
 *
 * `function_definition`'s `name:` field is a plain `word` (confirmed via
 * node-types.json and a real parse of both function-definition spellings
 * Bash accepts, `log() { ... }` and `function log { ... }` — both produce
 * the identical `function_definition name: (word) body: (...)` shape).
 *
 * -- calls: no distinct "call" node exists in this grammar; a command IS a
 * call, whether it names a defined function or an external program, and
 * this file makes NO attempt to tell them apart in the query itself -------
 *
 * Every command line — `log "starting"`, `grep foo bar`, `echo hi` — parses
 * to the SAME node type, `command`, with a `name:` field wrapping the
 * program/function name in a `command_name (word)` and zero or more
 * `argument:` words (confirmed via node-types.json and a real parse: `source
 * lib.sh`, `func_log`, and `grep foo bar` are all just `command` nodes,
 * structurally indistinguishable at the grammar level). This is not a gap
 * in this file's patterns — it is why R4's "only a call to a same-project
 * function counts as CALLS, external commands don't" requirement needs NO
 * bash-specific filtering logic at all: this file captures every command's
 * name as an ordinary `@reference.call`, exactly like every other
 * language's bare-call pattern, and lets `extractor.ts`'s ALREADY-EXISTING
 * cross-file bare-name resolver do the filtering for free. A `Function`
 * node is only ever created for an actual `@definition.function` capture —
 * never for a call site — so `grep`/`echo`/`ls`/any external program is
 * simply never a name the resolver's global index contains, and the call
 * silently falls into the existing `unresolved` bucket (the same bucket
 * every language's calls to an external library function already fall
 * into — calling `printf` in C, `console.log` in JS). No `Function` node,
 * no `CALLS` edge, no special-casing: verified end-to-end in
 * `test/bash.test.ts` that a real project's `grep`/`echo` calls produce
 * neither.
 *
 * **Known, documented limitation, not fixed here**: this engine only
 * attributes a CALLS edge to an ENCLOSING function definition
 * (`extractor.ts`'s `findEnclosingFunction` — a call site with no
 * containing `@definition.function` is silently dropped, matching every
 * other language's existing top-level-statement gap, e.g. a module-level
 * Python `print(x)` call outside any `def`). Bash scripts idiomatically run
 * a great deal of their real logic at the TOP LEVEL of a file, outside any
 * function — those calls are dropped by this pre-existing mechanism, not by
 * anything specific to this file. This engine's schema has no "Module CALLS
 * Function" edge to attribute a top-level call to (`CALLS` is
 * `Function → Function` only — `src/graph-db/schema.ts`), so fixing this
 * would be a schema-level change affecting every language, well outside
 * R4's scope. `test/bash.test.ts`'s cross-file scenario places its calls
 * inside a `main` function specifically to stay within this existing,
 * well-understood boundary; the real-project coverage measurement
 * (`docs/CROSS-FILE-COVERAGE.md`) reports how much of a real script's
 * top-level logic this leaves uncounted.
 *
 * -- module relationships: `source` / `.` (XSPEC-414 R4) --------------------
 *
 * Bash has no distinct "source statement" node — `source lib.sh` and
 * `. lib.sh` parse to the exact same generic `command` shape as any other
 * command, confirmed via a real parse. This file therefore uses a
 * `#eq?` text predicate (the same predicate mechanism `queries/csharp.ts`
 * already uses and documents as confirmed-supported by this binding) to
 * single out a command whose name is literally `source` or `.`, capturing
 * its first argument word as `@reference.import`. A quoted target
 * (`source "lib.sh"`) is handled the same way — `cleanImportTarget`
 * (`tag-query-engine.ts`) strips the surrounding quotes generically, same
 * as C's `#include "foo.h"`.
 */
export const BASH_TAGS_QUERY = `
; -- function definitions ----------------------------------------------------

(function_definition name: (word) @name) @definition.function

; -- calls: every command is a potential call; the project-only filter is
; the existing cross-file bare-name resolver, not anything in this pattern
; (see module doc comment) ---------------------------------------------------

(command name: (command_name (word) @name)) @reference.call

; -- module relationships: source / . -----------------------------------------

(command
  name: (command_name (word) @_cmd)
  argument: (word) @reference.import
  (#eq? @_cmd "source"))

(command
  name: (command_name (word) @_cmd)
  argument: (word) @reference.import
  (#eq? @_cmd "."))
`;

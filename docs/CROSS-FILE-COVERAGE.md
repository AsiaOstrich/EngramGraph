# Cross-file CALLS resolution coverage (XSPEC-333 R4)

`egr` resolves a call site's callee name to a specific `Function` node using a
bare-name heuristic (`extractProject`, `src/code-graph/extractor.ts`):
a same-file match wins (lexical shadowing), else a globally unique match
across the whole project, else the call is dropped as ambiguous/unresolved
(precision over recall — no import-graph resolution, no type inference).

This heuristic is identical across all 10 non-JS/TS languages `egr` supports
(C#, Python, Go, Java, Kotlin, Rust, C++, Ruby, PHP, Dart) — one tag-query
extraction step feeds one shared resolver. "We support language X" without a
number is an empty claim; this page measures, per language, what fraction of
real cross-file call relationships that shared resolver actually wires up,
on a real public repo. Format and intent borrowed from
[colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)'s
published per-language resolution-coverage numbers — this is not a
reproduction of their numbers (different tool, different corpora), only the
same discipline of measuring instead of asserting.

## Methodology

A naive "resolved CALLS edges / total symbols" ratio is misleading: many
symbols (entry points, `main`, framework callback hooks the runtime invokes
by convention, public API surface only consumed by code outside the
measured subdirectory, dead code) can **never** get a cross-file edge no
matter how good the resolver is. Counting them in the denominator would
silently deflate every language's score by how many "leaf" symbols that
repo's slice happens to contain — a corpus-composition artifact, not a
resolver measurement.

`scripts/measure-cross-file-coverage.ts` (run with `npx tsx`, not shipped in
`dist` — a measurement tool, not a product feature) separates the two cases
that must not share a denominator:

1. **Parse every file** via `collectExtraction` (the same per-file step
   `extractProject` runs internally) to get, per file, the unresolved raw
   call sites (`rawCalls`: caller id + bare callee name).
2. **Run the real `extractProject`** over the same file set to get the
   actual resolved `CALLS` edges a consumer of the graph would see.
3. Build `calleeOccurrences`: bare callee name → set of files containing at
   least one call site naming it (textual evidence a name is invoked from
   *some* file, ignoring same-file shadowing at this step — this is "does
   textual evidence of a cross-file reference exist," not a resolution
   replay).
4. For every defined `Function` node `s`:
   - `otherFiles` = files (other than `s`'s own) with a textual call site
     naming `s`'s bare name.
   - `otherFiles` empty → **excluded from the denominator**, tallied
     separately as "no cross-file textual evidence" (an entry-point-shaped
     symbol for this corpus — the resolver had nothing to fail at).
   - `otherFiles` non-empty → a genuine resolution *opportunity*:
     denominator += 1; numerator += 1 iff the real `extractProject` output
     contains ≥ 1 `CALLS` edge into `s` from a different file.
5. **Coverage % = numerator / denominator.**

This is deliberately not a ground-truth/oracle recall measurement — no
independently labeled "correct call graph" exists for these repos. It scores
the heuristic against the textual evidence its own inputs contain, which is
the same signal the resolver itself works from. A cross-file call shadowed
by a same-named local function at the caller's site (the resolver's
same-file-wins rule fires there instead, by design) shows up here as a
coverage miss for the would-be target — a real, intentional
precision-over-recall tradeoff of the resolver, not a bug, called out
per-language below where it visibly moves the number.

Run it yourself: `npx tsx scripts/measure-cross-file-coverage.ts <language> <dir> [--json]`.

## Results

One real public repo per language, a representative subdirectory (not the
whole repo — keeps parse time and misses-review sane). Not cherry-picked for
a good score: picked before running, kept whatever number came out.

| Language | Repo (subdir measured) | Files | Candidates (denominator) | Coverage |
|---|---|---:|---:|---:|
| C# | [JamesNK/Newtonsoft.Json](https://github.com/JamesNK/Newtonsoft.Json) `Src/Newtonsoft.Json` | 240 | 1517 | 26.8% |
| Python | [psf/requests](https://github.com/psf/requests) `src/requests` | 19 | 92 | 51.1% |
| Go | [gin-gonic/gin](https://github.com/gin-gonic/gin) (root package) | 19 | 81 | 74.1% |
| Java | [google/gson](https://github.com/google/gson) `gson/src/main/java` | 86 | 636 | 19.7% |
| Kotlin | [Kotlin/kotlinx.coroutines](https://github.com/Kotlin/kotlinx.coroutines) `kotlinx-coroutines-core/common/src` | 111 | 640 | 24.4% |
| Rust | [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep) `crates/core` + `crates/matcher` | 25 | 943 | 7.0% |
| C++ | [google/leveldb](https://github.com/google/leveldb) `db`, `table`, `util`, `include` | 118 | 665 | 28.0% |
| Ruby | [sinatra/sinatra](https://github.com/sinatra/sinatra) `lib` | 7 | 26 | 42.3% |
| PHP | [guzzle/guzzle](https://github.com/guzzle/guzzle) `src` | 47 | 153 | 51.6% |
| Dart | [dart-lang/http](https://github.com/dart-lang/http) `pkgs/http/lib` | 27 | 40 | 30.0% |

(TypeScript/JavaScript — the engine's pre-existing baseline, not part of this
batch of 10 — measures at 100% on `src/code-graph` itself, 7/7 candidates;
too small a sample to be a meaningful separate data point and not the
subject of this round.)

## Open questions — systematic, one-glance-obvious causes (not fixed here)

**Ambiguity, not parse failure, dominates the low scores (C#, Java, Kotlin,
Rust, C++).** The resolver's policy is: a bare name matching >1 function
project-wide is left *unresolved on purpose* (ambiguous, precision over
recall) rather than guessed at. Every one of these five repos hits this hard
because they lean on **OOP/trait polymorphism with conventionally-repeated
method names** — many classes/impls each defining their own
`Close`/`Read`/`Flush` (C#, `Newtonsoft.Json`'s Bson/Json reader-writer
hierarchy), `toString`/`translateName` (Java, `gson`'s many `TypeAdapter`/
`FieldNamingPolicy` implementers), `resumeWith`/`start` (Kotlin,
`kotlinx.coroutines`'s many `Continuation`/`Job` implementers), or
`Compare`/`Name` (C++, `leveldb`'s `Comparator` implementers). The resolver
qualifies the *definition* by its enclosing class/impl (`file#Class.method`),
but cross-file *resolution* still keys off the bare unqualified name (see
`collectExtraction`'s `names` map in `extractor.ts`) — so five different
classes each defining `Close()` collide into one ambiguous bucket globally,
by design. This is not specific to any one language's tag-query file; it is
a property of the shared resolver interacting with how common a codebase's
naming style is. **Rust is the extreme case (7.0%)**: `ripgrep`'s shell-
completion generators (`crates/core/flags/complete/{bash,fish,zsh,powershell}.rs`)
each implement the same trait method names (`generate`, `is_switch`,
`name_short`) once per shell — a textbook one-name-many-impls shape that
this resolver is, by its own documented design, never going to wire up
without becoming type-aware. Not a bug to fix in this round; flagged because
it is the most visible instance of a resolver-wide, already-documented
tradeoff (see `extractor.ts`'s module doc), not a new discovery.

**Small-sample noise (Ruby, Dart).** Ruby's `sinatra/lib` slice has only 26
denominator candidates and Dart's `http/lib` slice only 40 — both language
picks were constrained to a small, focused library rather than a framework
with a large blast radius, so a handful of misses swing the percentage by
several points each. Not treated as representative of the ceiling for either
language; a larger corpus would narrow the confidence interval, not
necessarily change the qualitative story (both still hit the same "shared
interface method name across types" pattern the OOP languages above do, just
at much smaller N — see `close`/`send`/`call` misses in Ruby, `send`/`close`
misses in Dart).

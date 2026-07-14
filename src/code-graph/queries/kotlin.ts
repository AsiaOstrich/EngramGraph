/**
 * Kotlin tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333
 * R2c batch 2. Same capture-naming convention as javascript.ts/csharp.ts/
 * go.ts (`@definition.function`, `@definition.class`, `@name`,
 * `@reference.call`, `@reference.call.arg`). Node-type names below were read
 * from `@tree-sitter-grammars/tree-sitter-kotlin`'s `src/node-types.json`
 * (1.1.0 — see grammars.d.ts's doc comment for **why this specific package**
 * is used instead of the older, more widely-referenced `tree-sitter-kotlin`
 * — a real operational finding, not a stylistic preference) and verified
 * against real parses via `Parser.Query.matches`, not guessed.
 *
 * -- definitions --------------------------------------------------------------
 *
 * `function_declaration`, `class_declaration` and `object_declaration` all
 * have a proper `name: (identifier)` field in this grammar (unlike the older
 * fwcd grammar this file's first draft was verified against, which has *no*
 * field names at all — see grammars.d.ts). `class_declaration` is reused for
 * **both** `class` and `interface` (confirmed against a real parse of
 * `interface Shape { fun area(): Double }` — same node type, just an
 * `interface` keyword token instead of `class`, both with `name:`
 * resolving correctly), so no separate interface pattern is needed, unlike
 * C#/Java's distinct `interface_declaration` node type.
 *
 * A body-less function (an abstract interface method, e.g. `fun area():
 * Double` with no `{...}`) is still an ordinary `function_declaration` node
 * in this grammar (confirmed: no distinct "signature-only" node type the
 * way Rust's `function_signature_item` is) — captured the same way as every
 * other function, contributing no call site simply because it has no body
 * to search, the same "declare, don't special-case" treatment as this
 * engine's other body-optional cases.
 *
 * `object_declaration` (a Kotlin singleton, `object Registry { ... }`) is
 * captured too — low-cost bonus scope, and genuinely useful here (unlike
 * Go's struct capture): its `class_body` is a real lexical container, so a
 * function inside an `object` block qualifies to `file#Registry.register`
 * via the shared range-containment `qualifyFunctions`, no engine change
 * needed.
 *
 * `companion_object`'s `name:` field is **optional** — most real Kotlin
 * companion objects are anonymous (`companion object { ... }`, implicitly
 * named `Companion`). This file only captures the rare **named** form
 * (`companion object Named { ... }`) as `@definition.class`, verified
 * against a real parse that the unnamed form simply produces zero matches
 * for this pattern (not a crash, not a wrong id) rather than trying to
 * synthesize a name for the common anonymous case. A function inside an
 * *anonymous* companion object is not left unqualified, though: since
 * `qualifyFunctions`' range-containment check walks *every* captured
 * definition regardless of nesting depth, and the anonymous
 * `companion_object` itself is simply never a captured definition, the
 * function still finds the *enclosing class* (`class Foo { companion object
 * { fun create() {...} } }`) as its nearest captured ancestor — qualifying
 * to `file#Foo.create`, not a bare `file#create`. This is arguably *more*
 * semantically correct than inventing a synthetic "Companion" scope layer
 * would be, since real Kotlin call sites reference companion members as
 * `Foo.create()`, not `Foo.Companion.create()` — a deliberate simplification,
 * not an oversight, documented here so it is not "fixed" into something
 * worse.
 *
 * **Not handled, found by adversarial review**: a *secondary* constructor
 * (`constructor(y: String) : this(y.length) { ... }`) is `secondary_constructor`
 * — a node type with **no name-bearing field at all** (confirmed against a
 * real parse: its children are just the `constructor` keyword,
 * `function_value_parameters`, an optional `constructor_delegation_call`,
 * and a body), unlike every other definition shape in this file. Capturing
 * it would need a synthesized name (e.g. reusing the enclosing class's
 * name, the way C#/Java's constructors repeat their class name) rather than
 * a `name:`/`(identifier)` this file's existing patterns can just declare —
 * a materially different, not-yet-verified shape of fix. Left as a
 * documented Open Question rather than rushed in under-verified: a
 * secondary constructor's body (and any calls inside it) is currently
 * silently not extracted at all.
 *
 * A lambda bound to a variable (`val log = { m: String -> println(m) };`,
 * `val` or `val`-typed) mirrors the other languages' "value bound to a
 * variable" pattern via `property_declaration (variable_declaration
 * (identifier) @name) (lambda_literal) @definition.function`. Kotlin's
 * destructuring declaration (`val (a, b) = pair`) wraps its names in a
 * *different* node, `multi_variable_declaration` — confirmed against a real
 * parse that this pattern produces zero matches for that shape (not a
 * cross-paired wrong name the way Go's original short_var_declaration draft
 * did) — same "safe by construction, verified not asserted" finding as
 * Rust's file.
 *
 * -- calls: this grammar's `call_expression` has no field names either, and
 * — a finding NOT anticipated by the task, discovered during this file's
 * development — needed WIDENING beyond a naive port of the other languages'
 * shape to cover Kotlin's very common trailing-lambda call syntax ----------
 *
 * A bare call (`helper(x)`) is `call_expression` with a direct `identifier`
 * child (the callee) alongside a `value_arguments` child (the parenthesized
 * args). A first-draft pattern requiring *both* — `(call_expression
 * (identifier) @name (value_arguments))` — was confirmed against a real
 * parse of Kotlin's idiomatic trailing-lambda call syntax (`run { helper()
 * }`, `apply { ... }`, `let { ... }`, `also { ... }` — scope functions used
 * pervasively in real Kotlin, not a corner case) to **miss the outer call
 * entirely**: `run { helper() }` parses as `call_expression` with children
 * `[identifier "run", annotated_lambda]` — **no** `value_arguments` node at
 * all when every argument is supplied via the trailing-lambda block, so the
 * `(value_arguments)` requirement excluded exactly the calls this idiom is
 * most commonly used for. Fixed by dropping that requirement —
 * `(call_expression (identifier) @name) @reference.call` — verified against
 * a real parse this still correctly captures ordinary parenthesized calls,
 * trailing-lambda-only calls, and calls with both (`foo(x) { ... }`) with no
 * duplicate or cross-matched captures (confirmed: `call_expression`'s only
 * other children — `annotated_lambda`, `type_arguments`, `value_arguments`
 * — never themselves produce a bare `identifier` as a *direct* child of the
 * call_expression, so there is exactly one such identifier per
 * call_expression, unambiguously the callee).
 *
 * Member calls (`obj.method()`) go through `navigation_expression`, whose
 * children for a simple case are `[identifier, ".", identifier]` — but for a
 * **chained** access (`a.b.c()`), the *outer* `navigation_expression`'s
 * children are `[navigation_expression, ".", identifier]` (the receiver side
 * is itself a nested navigation_expression, not a bare identifier),
 * confirmed against a real parse. A pattern requiring the receiver-side
 * child specifically be `(identifier)` would therefore only match one-level
 * member access and silently miss every chained call — fixed by using
 * tree-sitter's `_` wildcard for the receiver-side child (`(navigation_expression
 * (_) [\".\" \"?.\"] (identifier) @name)`), verified against a real 3-level chain
 * (`x.y.z.w()`) to correctly capture only the final segment (`w`) with no
 * duplicate match from the inner nested navigation_expression nodes (the
 * `@reference.call` tag is anchored on `call_expression`'s *direct* child,
 * which is only ever the outermost navigation_expression — the inner ones
 * are nested one level deeper and never directly parented by a
 * call_expression, so they cannot independently satisfy this rule).
 *
 * **Kotlin's null-safe navigation (`obj?.method()`) was a real gap in this
 * file's first draft, found by adversarial review, not the original
 * development pass**: `?.` is a *separate* anonymous token from `.` in this
 * grammar (confirmed against a real parse: `obj?.method()`'s
 * navigation_expression children are `[identifier, "?.", identifier]`, not
 * `"."`), so a pattern with only the literal `"."` silently captured **zero**
 * calls for any safe-call chain — a common, everyday Kotlin idiom (arguably
 * more common in real code than the plain `.` form for anything nullable),
 * not a corner case. Fixed with tree-sitter's alternation syntax,
 * `[\".\" \"?.\"]` in place of a single literal, verified against a real parse
 * of `obj?.method()`, a mixed chain (`a?.b()?.c()`), and a plain `.` call
 * side by side to confirm all three are now captured correctly (chain
 * verified to still return only the final segment's name per call, same as
 * the plain-dot case).
 *
 * A **`::`-qualified** navigation (`StringUtils::upper`, see the
 * by-reference-argument section below) is structurally identical to a
 * `.`-based navigation_expression in this grammar (`[identifier, "::",
 * identifier]`) — the literal `"."`/`"?."` alternation in the pattern above
 * is what keeps this file's member-*call* pattern from also matching a bare
 * qualified-reference
 * expression that isn't itself being called (confirmed: `"::"` and `"."` are
 * distinct anonymous tokens in this grammar, verified via a literal-token
 * query against both forms side by side).
 *
 * -- Kotlin-specific false-positive risk explicitly named in the task:
 * named arguments (`register(handler = handlerFn, path = path)`) — a
 * DIFFERENT mechanism from C#'s than needed, because this grammar has no
 * field names to test for absence -------------------------------------------
 *
 * C#'s `argument`/Python's `keyword_argument` each give the codebase either
 * a `name:` field to test with `!name` or a wrapping node type that
 * structurally isolates keyword args. This grammar's `value_argument` has
 * **neither**: a positional argument (`register(path, handlerFn)`) has
 * value_argument with a *single* child (`identifier "path"` / `identifier
 * "handlerFn"`), but a named argument (`register(handler = handlerFn, path =
 * path)`) has value_argument with **two** children — `identifier "handler"`
 * (the parameter label) then `identifier "handlerFn"` (the actual value) —
 * both plain `identifier`s with no field or wrapper to distinguish them,
 * confirmed against a real parse. Fixed with tree-sitter's leading+trailing
 * anchor (`.`): `(value_argument . (identifier) @reference.call.arg .)`
 * requires the captured identifier be **both** the first and the last child
 * of `value_argument` — true only for the single-child positional case;
 * verified against a real parse of both forms side by side that this
 * correctly captures `path`/`handlerFn` from the positional call and
 * captures **nothing** from the named-argument call (neither the label nor
 * the value) — the same "miss a rarer positive rather than admit a wrong
 * one" tradeoff as C#'s `!name` guard, reached via a different mechanism
 * because this grammar gives this file no field to test.
 *
 * -- by-reference call arguments — Kotlin supports BOTH a bare-identifier
 * form (like JS/Go/Rust/Python) AND an explicit `::`-reference form (like
 * Java), for two DIFFERENT and both-valid reasons, verified independently
 * rather than assumed from either precedent -------------------------------
 *
 * Unlike Java (which structurally *cannot* pass a bare method name as a
 * value — a real, considered rejection in queries/java.ts), Kotlin *does*
 * have genuine first-class function values: a lambda bound to a `val` (this
 * file's own lambda-binding pattern above) is a real value, and passing that
 * `val`'s bare name to another call (`registerCallback(onClick)`) is
 * completely ordinary, valid Kotlin — the same JS/Go/Rust/Python idiom, not
 * Java's structurally-impossible case. The bare-identifier pattern is
 * therefore kept (anchored against the named-argument case above), matching
 * that majority precedent rather than Java's.
 *
 * Kotlin *additionally* has its own explicit `::function`/`Type::method`
 * "callable reference" syntax (Java's exact idiom, layered on top rather
 * than replacing the bare form) — commonly used to pass an existing
 * top-level or member function directly, without first binding it to a
 * `val` (`items.forEach(::println)`, `items.map(StringUtils::upper)`).
 * Two distinct node shapes, both verified against real parses: a **bare**
 * reference (`::println`) is `callable_reference` with a single `identifier`
 * child; a **qualified** reference (`StringUtils::upper`) is, in this
 * grammar, actually a `navigation_expression` (not `callable_reference` —
 * confirmed against a real parse; this genuinely differs from the older
 * fwcd grammar, where both forms are `callable_reference`) using literal
 * `"::"` in place of `"."`, requiring its own pattern
 * (`(navigation_expression (_) "::" (identifier) @reference.call.arg)`) —
 * verified this correctly captures only `upper`, never the receiver type
 * `StringUtils`, mirroring Java's own trailing-anchor fix for its
 * `method_reference` pattern (see queries/java.ts) even though the concrete
 * node shape is different here. Both by-reference forms are anchored to be
 * the sole child of `value_argument`, so the same named-argument exclusion
 * above applies to them too (verified: `foo(handler = ::println)` and
 * `bar(handler = StringUtils::upper)` both correctly capture nothing).
 *
 * **Not fixed, flagged by adversarial review**: all three by-reference
 * patterns anchor only on `value_argument`, not on `value_argument` being
 * itself inside a `call_expression`'s `value_arguments` — `value_argument`
 * nodes are also used by superclass-constructor delegation
 * (`class D : Base(handlerFn)`) and (unverified, not checked) annotation
 * arguments, so a bare-identifier/callable-reference in one of those
 * positions is also captured as a `@reference.call.arg`. In practice this
 * mostly self-corrects: `findEnclosingFunction` only attributes a captured
 * call site to something when it falls inside a *captured* function's byte
 * range, and a top-level `class D : Base(handlerFn)` has no enclosing
 * function, so the capture is simply dropped. The narrow residual case —
 * a *local* class declared inside a function, delegating to a superclass
 * constructor with a bare-identifier argument — would be misattributed to
 * that enclosing function as a spurious CALLS edge. Not fixed in this batch
 * (would need anchoring through an intermediate `value_arguments` ancestor
 * specifically tied to a `call_expression`, not yet verified against a real
 * parse); documented here as an Open Question.
 *
 * -- Kotlin-specific false-positive risk found during this file's
 * development, not named in the original task (the same underlying
 * limitation as Go's type-conversion ambiguity, Python's class-instantiation
 * ambiguity, Rust's tuple-struct-construction ambiguity and C++'s
 * functional-style-cast ambiguity) — **class instantiation is grammatically
 * identical to a call** -------------------------------------------------
 *
 * `Foo()` (instantiating class `Foo`, Kotlin has no `new` keyword) parses to
 * the exact same shape as a real call — confirmed against a real parse —
 * since this grammar has no distinct "constructor call" node type. Same
 * mitigation and same narrow residual risk as every other language sharing
 * this limitation: `@definition.class` captures never enter the bare-name
 * `Function` index CALLS resolution reads from, so this only fabricates a
 * wrong edge when an unrelated function happens to share the exact name of
 * a class/object elsewhere in the indexed corpus. Grouped as the same shared
 * limitation, not a new Kotlin-only quirk.
 *
 * -- explicit generic-type-argument calls are a KNOWN, VERIFIED GAP in this
 * grammar itself, not something this file's patterns can route around -----
 *
 * `identity<Int>(5)` (an explicit-type-argument call, Kotlin's analogue of
 * C++'s `identity<int>(5)`/Rust's turbofish) was confirmed against a real
 * parse to be parsed as a **chained comparison expression** —
 * `(identity < Int) > (5)` — not a call at all: this is Kotlin's own
 * well-known `<`/`>`-vs-generics grammar ambiguity (the real Kotlin compiler
 * resolves it with type information a pure-syntax parser doesn't have; this
 * specific tree-sitter grammar's disambiguation default lands on
 * "comparison"). The type-inferred form (`identity(5)`, by far the more
 * common real-world spelling) parses correctly as an ordinary call and is
 * captured normally. Documented as an Open Question inherent to this
 * grammar, not a gap in this file's queries — no pattern shape can recover a
 * call from a tree that was never parsed as one.
 */
export const KOTLIN_TAGS_QUERY = `
; -- function / class / object / (named) companion-object definitions ------

(function_declaration name: (identifier) @name) @definition.function

(class_declaration name: (identifier) @name) @definition.class

(object_declaration name: (identifier) @name) @definition.class

; only the rare NAMED companion-object form matches (see module doc comment
; for why the common anonymous form is deliberately left uncaptured).
(companion_object name: (identifier) @name) @definition.class

; a lambda bound to a variable: \`val log = { m: String -> println(m) }\`.
; Destructuring (\`val (a, b) = ...\`) wraps its names in a different node
; (multi_variable_declaration) and is safely excluded — see module doc
; comment.
(property_declaration
  (variable_declaration (identifier) @name)
  (lambda_literal) @definition.function)

; -- calls ---------------------------------------------------------------------

; \`helper(x)\` — also matches Kotlin's trailing-lambda call syntax
; (\`run { ... }\`) where there is no value_arguments node at all (see module
; doc comment for the real gap this widening fixes over a naive port of the
; other languages' shape). Also matches class-instantiation-as-call
; (\`Foo()\`) — a verified, NOT excludable, Open Question shared with every
; other language on this engine (see module doc comment).
(call_expression (identifier) @name) @reference.call

; \`obj.method()\` / \`obj?.method()\` — any receiver, any chain depth, both the
; plain and null-safe navigation operator (the "_" wildcard on the receiver
; side is required to capture chained access like \`a.b.c()\` correctly; the
; "?." alternative was a real gap found by adversarial review — see module
; doc comment for both). The "." / "?." alternation keeps this from also
; matching a "::" qualified callable reference used as a bare value (not
; itself being called) — see module doc comment.
(call_expression
  (navigation_expression (_) [\".\" \"?.\"] (identifier) @name)) @reference.call

; a function passed *by reference* as a direct (non-nested) call argument —
; Kotlin supports BOTH a bare-identifier value (a val-bound lambda, the
; JS/Go/Rust/Python idiom) AND an explicit "::" callable reference (Java's
; idiom, layered on top) — see module doc comment for why both are kept,
; unlike Java which only has the latter. All three anchored to the *sole*
; child of value_argument, which is what excludes named arguments
; (\`handler = ...\`) without a field to test for absence (see module doc
; comment).
(value_argument . (identifier) @reference.call.arg .)

(value_argument . (callable_reference (identifier) @reference.call.arg) .)

(value_argument . (navigation_expression (_) "::" (identifier) @reference.call.arg) .)
`;

/**
 * PHP tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333
 * R2c batch 3 (Ruby/PHP/Dart, the last mainstream-language batch). Same
 * capture-naming convention as every other language on this engine
 * (`@definition.function`, `@definition.class`, `@name`, `@reference.call`,
 * `@reference.call.arg`). Node-type names below were read from
 * `tree-sitter-php`'s `php/src/node-types.json` (0.23.12 — this repo uses
 * the `php` dialect export, not `php_only`; see grammars.d.ts's doc comment
 * for both the version pin and the dialect choice) and verified against real
 * parses via `Parser.Query.matches`, not guessed.
 *
 * -- definitions --------------------------------------------------------------
 *
 * `class_declaration`/`interface_declaration`/`trait_declaration` all have a
 * `name: (name)` field with an identical shape — one pattern per node type,
 * all tagged `@definition.class` (this engine has no separate "interface"/
 * "trait" node label; both are treated as scope-qualifying containers the
 * same way Kotlin's `object_declaration` is a bonus non-class scope — see
 * queries/kotlin.ts).
 *
 * `function_definition` (top-level functions) and `method_declaration`
 * (class/interface/trait members) both have `name: (name)` — one pattern
 * each, tagged `@definition.function`. `method_declaration`'s `body` field
 * is OPTIONAL (`required: false`) for interface/abstract methods with no
 * body (`public function area();`) — but this file's pattern places no
 * constraint on `body:` at all, so a bodyless interface/abstract method IS
 * still captured as an (empty, call-free) Function node, verified against a
 * real parse of `interface Shape { public function area(); }`. This
 * MIRRORS Java's/C#'s own precedent (their `method_declaration` likewise
 * captures interface/abstract methods with no body — see queries/java.ts's
 * module doc comment), not C++'s: C++'s bodyless prototype is a genuinely
 * DIFFERENT node type (`field_declaration`, not `function_definition`),
 * which is why C++ excludes it and PHP does not — a per-grammar structural
 * fact, not a uniform engine-wide rule this file should have assumed without
 * checking (an early draft of this file wrongly assumed the C++ precedent
 * generalized here; corrected after actually parsing PHP's interface-method
 * shape and seeing `method_declaration` produced regardless of body).
 *
 * A closure/arrow-function literal bound to a variable (`$handlerFn =
 * function($x) { bar($x); };` / `$logFn = fn($m) => puts($m);`) mirrors
 * JS/C#/Python/Ruby's "value bound to a variable" pattern — but PHP's
 * variables are ALWAYS `$`-prefixed, so the grammar wraps every variable
 * reference in `variable_name (name)` rather than a bare `identifier`; this
 * file captures the INNER `(name)` node (never including the `$` sigil) on
 * both the definition side (`assignment_expression left: (variable_name
 * (name) @name) right: (anonymous_function)`) and the by-reference-argument
 * side below, so the two sides' captured text lines up exactly. PHP's
 * `list($a, $f) = [...]` / `[$a, $f] = [...]` destructuring assigns through
 * a DIFFERENT left-hand node type, `list_literal`, not `variable_name` —
 * verified against a real parse that both spellings produce
 * `assignment_expression left: (list_literal ...)`, safely excluded from
 * this pattern by construction, not merely assumed (the same "verified, not
 * asserted" finding as Rust's/Ruby's own destructuring checks).
 *
 * -- calls ----------------------------------------------------------------
 *
 * FOUR distinct call node types exist in this grammar, one pattern each:
 * `function_call_expression` (bare, `helper($x)`), `member_call_expression`
 * (`->`, `$obj->method($x)`), `nullsafe_member_call_expression` (`?->`,
 * `$obj?->method($x)` — genuinely a SEPARATE node type here, not merely a
 * different operator token the way Ruby's `&.` is, so it needs its own
 * pattern rather than an alternation), and `scoped_call_expression` (`::`,
 * `Foo::bar($x)` / `self::bar($x)` / `parent::bar($x)` — `self`/`parent`/
 * `static` parse as `relative_scope`, still matched by this pattern since it
 * places no constraint on the `scope:` field's node type at all). A
 * **chained** member call (`a->b()->c($x)`) was verified: the outer call's
 * `object:`/`name:` fields accept ANY expression type for the receiver
 * side, so no wildcard anchor is needed the way Kotlin's grammar required
 * one — this grammar's field-based (not purely-positional) structure makes
 * "any receiver, any depth" the DEFAULT behavior of an unconstrained field,
 * not something requiring an explicit `(_)` wildcard.
 *
 * **A real, previously-undocumented silent gap found by adversarial
 * review**: a NAMESPACE-QUALIFIED bare call (`App\Util\helper($x)`, or the
 * global-namespace-escape spelling `\strlen($x)` — both common, idiomatic
 * modern PHP, not edge cases) sets `function_call_expression`'s `function:`
 * field to a `qualified_name` node, NOT a bare `(name)` — confirmed against
 * a real parse that this file's first-draft bare-call pattern (`function:
 * (name)`) matched NEITHER spelling at all (zero `@reference.call` captures,
 * confirmed end-to-end via `extractCodeGraph` producing zero CALLS edges for
 * a namespaced call whose target was defined in the same file). Fixed with a
 * second pattern anchored on `qualified_name`'s own UNLABELED direct child
 * (the actual, final function name — the namespace path itself lives in a
 * separate `prefix:` field, a `namespace_name` node whose own `(name)`
 * grandchildren this pattern does NOT reach), verified via an actual
 * `Parser.Query` run against a deeply-namespaced call (`App\Util\helper(...)`)
 * to confirm it captures only `"helper"`, never any namespace segment.
 * `scoped_call_expression`'s own `name:` field, by contrast, was already
 * unaffected by this gap — verified that a namespace-qualified `scope:`
 * (`\App\Foo::bar($x)`) still produces a plain `(name)` for the actual
 * method name regardless of the scope's own shape, so no second pattern was
 * needed there.
 *
 * **A structural exclusion found and confirmed, not merely hoped for**:
 * PHP's own "variable-variable" dynamic call (`$fn = 'helper'; $fn();`) sets
 * `function_call_expression`'s `function:` field to `(variable_name (name))`
 * — a DIFFERENT node type from this file's `function: (name)` bare-call
 * pattern — confirmed via a real parse side-by-side with an ordinary
 * `helper()` call. This means dynamic variable calls are excluded FOR FREE,
 * with no special-casing: this file never tries (and structurally cannot
 * accidentally) resolve `$fn` as if it were the callee's own name, unlike a
 * language where "the thing being called" and "an identifier" share one node
 * shape regardless of whether it's a direct name or a variable holding one.
 *
 * -- PHP-specific false-positive risks explicitly named in the task,
 * evaluated one at a time -------------------------------------------------
 *
 * **Named arguments** (PHP 8+, `foo(handler: $x, path: $y)`): verified
 * against a real parse that the `argument` node itself carries an OPTIONAL
 * `name:` field (the label, `(name)` type) alongside its value child — a
 * positional argument's `argument` node has NO `name:` field at all. This
 * file's by-reference pattern uses tree-sitter's negated-field predicate,
 * `(argument !name (variable_name (name) @reference.call.arg))` (the same
 * `!name` mechanism C#'s `nameof`/named-argument exclusion uses — see
 * queries/csharp.ts), double-checked against a real parse of
 * `foo(handler: $x, path: $y)` side-by-side with `foo($x, $y)`: the named
 * form captures nothing, the positional form captures both `x` and `y`.
 *
 * **`::` static calls** (`Foo::bar($x)`): handled by the dedicated
 * `scoped_call_expression` pattern above, no separate consideration needed
 * beyond what's already documented there.
 *
 * **`->`/`?->` calls**: handled by the dedicated `member_call_expression`/
 * `nullsafe_member_call_expression` patterns above — genuinely two SEPARATE
 * node types in this grammar (not an operator-alternation the way Ruby's
 * `&.`/Kotlin's `?.` are), each needing its own pattern; verified against a
 * real parse of both forms side by side, and against `Foo::BAR`
 * (class-constant access) to confirm it parses as a DIFFERENT node,
 * `class_constant_access_expression`, never colliding with the call
 * patterns above.
 *
 * -- PHP's own by-reference-argument idiom: first-class callable syntax
 * (PHP 8.1+, `funcName(...)`) — found during this file's development, not
 * named in the original task, but the closest PHP analogue of Kotlin's
 * `::method`/Java's `method_reference`/C++'s pointer-to-member idiom --------
 *
 * PHP has no idiomatic way to pass a "bare function name" as a value the
 * way JS/Go/Python/Rust/Kotlin/Ruby do — a bare, unquoted, un-sigiled name
 * in an expression position (`foo(bar)`, no `$`) is a reference to an
 * undefined CONSTANT in PHP, not the function `bar` (confirmed against a
 * real parse: `foo(BAR)` produces `argument (name)`, structurally distinct
 * from `argument (variable_name (name))` — deliberately NOT captured here,
 * since a bare constant reference is essentially never a callable in real
 * code). The two REAL PHP idioms for "pass a function by reference" are
 * string/array callables (`'strtoupper'`, `[$obj, 'method']` — string/array
 * literals, a categorically different node shape this engine does not chase
 * for any language, the same "don't capture string literals as call
 * targets" restraint as Ruby's rejected bare-symbol idea) and PHP 8.1's
 * first-class callable syntax, `funcName(...)` / `$obj->method(...)` /
 * `Foo::bar(...)` — a genuine syntactic reference, verified against a real
 * parse to have a DISTINCTIVE shape: the referenced call's own `arguments:`
 * field is `(arguments (variadic_placeholder))` — literally just the `...`
 * token, no real arguments — confirmed different from both an ordinary
 * zero-arg call (`helper()` → `arguments: (arguments)`, no children at all)
 * and an ordinary call with real arguments, so this pattern cannot collide
 * with either. Captured for all three receiver shapes (bare, `->`, `::`),
 * each anchored with the same `!name` guard as the plain by-reference
 * pattern so a first-class-callable value passed as a NAMED argument
 * (`foo(handler: strlen(...))`) does not ALSO produce a
 * `@reference.call.arg` capture — verified against a real parse. **This is
 * narrower than it may first read, a wording correction made after
 * adversarial review**: the `!name` guard only suppresses the
 * BY-REFERENCE-ARGUMENT capture for that nested case — it does NOT stop the
 * ordinary bare-call pattern from separately matching `strlen(...)` itself
 * (see the very next paragraph), so "excluded" here means "not double
 * counted as a by-reference argument on top of the ordinary call capture",
 * not "produces no capture/edge at all".
 *
 * **A known, accepted minor imprecision, not fixed in this batch**: because
 * `strlen(...)`'s own shape is STILL a `function_call_expression` (just one
 * whose `arguments:` happens to be a lone placeholder), this file's ordinary
 * bare-call pattern ALSO matches it regardless of whether it appears as a
 * positional or a named argument value — meaning a first-class-callable
 * reference to a real, user-defined, resolvable function ALWAYS produces a
 * `@reference.call` capture (treating the reference as if it were an
 * invocation). When it's a POSITIONAL argument, this doubles up with the
 * correct `@reference.call.arg` capture (both resolving to the SAME target
 * id, so `buildCallEdges`'s aggregation — see extractor.ts — does not
 * fabricate a DIFFERENT, wrong edge, only inflates that one edge's
 * `call_count` property by one extra); when it's a NAMED argument value (the
 * `!name` guard case just above), there is no second capture to double up
 * with, so the ordinary-call capture stands alone as a normal, single,
 * correctly-targeted edge — not inflated, just present because this shape
 * genuinely, structurally satisfies the ordinary call pattern too.
 * Tree-sitter's query DSL has no general "this shape is NOT that other
 * shape" negation construct available to suppress the ordinary-call pattern
 * specifically for either nested case without an intrusive, language-specific
 * post-filter breaking the shared engine's design — so this is documented
 * as an accepted, narrow, metadata-only imprecision (the edge itself is
 * real; only its count is occasionally off by one), not a fabricated wrong edge, the
 * same class of blemish this engine already tolerates elsewhere (e.g.
 * Kotlin's coincidental-collision case in the real-world smoke test).
 *
 * -- found during this file's development, not named in the original task
 * — PHP is the FIRST language on this engine where class instantiation is
 * NOT ambiguous with a call ------------------------------------------------
 *
 * `new Foo($a)` parses to `object_creation_expression`, a node type this
 * file's call patterns never match at all — confirmed against a real parse
 * side by side with an ordinary call. Every other language on this engine
 * (Python/Go/Kotlin/Rust/Dart — see each one's own module doc comment)
 * shares a "bare invocation syntax is grammatically identical to
 * instantiation" limitation; PHP's mandatory `new` keyword and dedicated
 * node type mean this specific ambiguity simply does not exist here — a
 * positive contrast worth stating explicitly so a future reader does not
 * assume PHP shares every other language's version of this Open Question.
 * (An anonymous class, `new class { ... }`, wraps an `anonymous_class` node
 * with no `name:` field inside `object_creation_expression` — its methods
 * are still captured as ordinary `method_declaration`s but do not
 * scope-qualify to any class name, the same "transparent uncaptured
 * wrapper" precedent as Kotlin's anonymous `companion_object` — see
 * queries/kotlin.ts.)
 *
 * -- comment node type -----------------------------------------------------
 *
 * PHP's comment node is named plain `comment` (confirmed against
 * node-types.json), already covered by tag-query-engine.ts's
 * `COMMENT_NODE_TYPES` — no engine change needed for PHP, matching the
 * JS/TS/C#/Python/Go/Kotlin/Ruby precedent.
 */
export const PHP_TAGS_QUERY = `
; -- class / interface / trait definitions --------------------------------

(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.class
(trait_declaration name: (name) @name) @definition.class

; -- function / method definitions -----------------------------------------

(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.function

; a closure/arrow-function literal bound to a variable: \`$log = function($m)
; { puts($m); };\` / \`$log = fn($m) => puts($m);\`. PHP's list()/[] destructuring
; assigns through a DIFFERENT left-hand node type (list_literal, not
; variable_name) and is safely excluded — verified against a real parse.
(assignment_expression left: (variable_name (name) @name) right: (anonymous_function)) @definition.function
(assignment_expression left: (variable_name (name) @name) right: (arrow_function)) @definition.function

; -- calls -------------------------------------------------------------------

; bare: \`helper($x)\`. PHP's own "variable-variable" dynamic call (\`$fn();\`)
; sets \`function:\` to variable_name, not name, and is excluded for free — see
; module doc comment.
(function_call_expression function: (name) @name) @reference.call

; a NAMESPACE-QUALIFIED bare call (\`App\\Util\\helper($x)\`, or the
; global-namespace-escape spelling \`\\strlen($x)\`) — found by adversarial
; review, a real, previously-undocumented silent gap: \`function:\` is a
; \`qualified_name\` node here, not a bare \`(name)\`, so the pattern above does
; not match it at all (confirmed against a real parse: zero \`@reference.call\`
; captures for either spelling before this pattern was added). \`qualified_name\`
; wraps its namespace path in a separate \`prefix:\` field (a \`namespace_name\`
; node, itself containing further \`(name)\` grandchildren) and holds the
; actual, final function name as an UNLABELED direct child — this pattern
; anchors on that direct child, verified via an actual \`Parser.Query\` run
; side-by-side with a deeply-namespaced call (\`App\\Util\\helper(...)\`) to
; confirm it captures only \"helper\", never any of the namespace segments.
(function_call_expression function: (qualified_name (name) @name)) @reference.call

; \`->\` : \`$obj->method($x)\`, any receiver, any chain depth (unconstrained
; field, no wildcard needed — see module doc comment).
(member_call_expression name: (name) @name) @reference.call

; \`?->\` : \`$obj?->method($x)\` — a SEPARATE node type in this grammar, not an
; operator alternation — see module doc comment.
(nullsafe_member_call_expression name: (name) @name) @reference.call

; \`::\` : \`Foo::bar($x)\` / \`self::bar($x)\` / \`parent::bar($x)\`.
(scoped_call_expression name: (name) @name) @reference.call

; a function/Closure passed *by reference* as a direct positional call
; argument (mirrors JS/Go/Python/Rust/Kotlin/C#/Ruby/Dart's equivalent
; pattern). Named arguments (\`foo(handler: $x)\`) are excluded via the same
; \`!name\` guard C#'s nameof/named-argument pattern uses — verified against a
; real parse.
(argument !name (variable_name (name) @reference.call.arg))

; PHP 8.1+ first-class callable syntax (\`funcName(...)\` / \`$obj->method(...)\`
; / \`Foo::bar(...)\`) — the closest PHP analogue of Kotlin's \`::method\`/
; Java's method_reference. Distinctive shape (arguments = a lone
; variadic_placeholder, i.e. the literal "..." token) verified to never
; collide with an ordinary zero-arg call (\`arguments: (arguments)\`, no
; children) or a real-argument call — see module doc comment for the
; accepted minor call_count double-count this causes when the referenced
; function is ALSO resolvable as an ordinary ambient call.
(argument !name (function_call_expression function: (name) @reference.call.arg arguments: (arguments (variadic_placeholder))))
(argument !name (member_call_expression name: (name) @reference.call.arg arguments: (arguments (variadic_placeholder))))
(argument !name (scoped_call_expression name: (name) @reference.call.arg arguments: (arguments (variadic_placeholder))))
`;

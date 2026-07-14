/**
 * Dart tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333
 * R2c batch 3 (Ruby/PHP/Dart, the last mainstream-language batch, and the
 * hardest of the three — see grammars.d.ts's doc comment for the packaging
 * story). Same capture-naming convention as every other language on this
 * engine (`@definition.function`, `@definition.class`, `@name`,
 * `@reference.call`, `@reference.call.arg`). Node-type names below were read
 * from `@vokturz/tree-sitter-dart`'s `src/node-types.json` (1.0.0 — see
 * grammars.d.ts's doc comment for why this specific package is used instead
 * of the other four Dart-grammar candidates evaluated) and verified against
 * real parses via `Parser.Query.matches`, not guessed.
 *
 * -- definitions: a TWO-LEVEL wrapper shape, unlike every prior language ---
 *
 * This grammar wraps every function/method definition in TWO nested nodes:
 * an OUTER wrapper with no field labels at all (`function_definition` for
 * top-level functions, `method_definition` for class/mixin/extension
 * members) containing an unlabeled `function_signature`/`function_body`
 * pair as plain children, and an INNER `function_signature` (or, for
 * getters/setters, `getter_signature`/`setter_signature` nested one level
 * further inside a `method_signature`) that actually carries the `name:`
 * field. Verified against a real parse that the OUTER node's byte range
 * spans BOTH the signature AND the body — so this file captures
 * `@definition.function` on the OUTER node (`function_definition`/
 * `method_definition`), pulling `@name` from the nested inner signature node
 * — capturing the inner signature node instead (an easy first mistake) would
 * give the function a range covering ONLY its signature, silently breaking
 * this engine's range-containment `findEnclosingFunction`/`qualifyFunctions`
 * for every call inside the body (they would no longer be "inside" the
 * function's range at all).
 *
 * `class_definition`/`mixin_declaration`/`extension_declaration` all have a
 * `name: (identifier)` field — one pattern each, tagged `@definition.class`
 * (mixins/extensions are not literally classes, but ARE real lexical scope
 * containers whose methods should scope-qualify against them — the same
 * "bonus scope container" treatment as Kotlin's `object_declaration`; see
 * queries/kotlin.ts).
 *
 * Getters (`int get value => _value;`) and setters (`set value(int v) {
 * ... }`) DEFINED INSIDE A CLASS follow the SAME `method_definition
 * (method_signature (...))` wrapper depth as an ordinary method (unlike
 * constructors below), just with `getter_signature`/`setter_signature`
 * instead of `function_signature` inside — captured the same way, one
 * pattern each. Verified against a real parse that a getter/setter sharing a
 * name (Dart idiomatically pairs `get value`/`set value` for one logical
 * property) collapses onto the same qualified id, `ClassName.value` — the
 * same overload-collapse limitation this engine already documents for
 * C#/Kotlin (see extractor.ts's `qualifyFunctions` call-site comment), not a
 * new Dart-only quirk.
 *
 * **TOP-LEVEL getters/setters (outside any class) use a THIRD and FOURTH
 * wrapper shape, found by adversarial review, not exercised by this file's
 * first-draft class-scoped test cases**: `int get answer => 42;` at the top
 * level of a file is `getter_definition (getter_signature ...)` — bare,
 * unlabeled children mirroring `function_definition`'s own shape — NOT
 * `method_definition (method_signature (getter_signature ...))` the way a
 * class member is wrapped, confirmed against a real parse that neither
 * pattern above matched it at all (zero definition captures — a real Dart
 * library idiom, e.g. Flutter's top-level `defaultTargetPlatform` getter,
 * would have been silently invisible). Fixed with two more patterns
 * targeting `getter_definition`/`setter_definition` directly.
 *
 * A **nested/local function** (`void outer() { void inner() { ... } }`) uses
 * a THIRD wrapper shape, `local_function_declaration (lambda_expression
 * parameters: (function_signature name: (identifier) ...) body: (...))` —
 * verified against a real parse that `local_function_declaration`'s own
 * range spans the whole nested `lambda_expression` (signature + body), so
 * this file captures `@definition.function` on THAT outer node, mirroring
 * the same "capture the full-range outer wrapper, not the inner
 * signature-only node" discipline as the top-level case above.
 *
 * A closure/arrow-function literal bound to a variable (`var log = (String
 * m) { print(m); };` / `var log = (String m) => print(m);`) uses a FOURTH
 * shape: `initialized_identifier name: (identifier) @name value:
 * (function_expression ...)` — this node has an honest `name:`/`value:`
 * field pair (closer to JS's variable-declarator convention than the
 * signature-wrapping shapes above), used for BOTH local (`var`/`final`) and
 * top-level/field declarations alike (confirmed against a real parse of a
 * class-field closure initializer — same `initialized_identifier` node,
 * just reached through a `declaration` wrapper instead of a
 * `global_variable_declaration`/`local_variable_declaration` one; this
 * file's pattern does not care which wrapper contains it). Multi-variable
 * declarations mixing a closure (Dart has no destructuring-assignment
 * syntax the way JS/Ruby/PHP/Rust do — each `initialized_identifier` in an
 * `initialized_identifier_list` is independently name+value paired) carry
 * NO analogous cross-pairing risk the way Go's short_var_declaration bug
 * did — each binding is its own distinct node, not two parallel arrays.
 *
 * A bodyless abstract/interface method (`double area();`) is wrapped in a
 * bare `declaration`, NOT `method_definition` — verified against a real
 * parse — so this file's `method_definition`-anchored patterns correctly do
 * not capture it at all, the same "this engine only extracts BODIED
 * definitions" precedent as C++'s bodyless-prototype exclusion (see
 * queries/cpp.ts) and PHP's interface-method exclusion (see queries/php.ts)
 * — not a special case, a consequence of the same convention applying here
 * too.
 *
 * -- Open Question: constructors, deliberately NOT captured in this batch --
 *
 * Constructors are structurally the MOST awkward shape in this grammar,
 * evaluated and set aside rather than rushed in under-verified (the same
 * judgment call as Kotlin's secondary-constructor Open Question — see
 * queries/kotlin.ts): a bodyless constructor (`Foo(this.x);`, extremely
 * common for simple data classes) sits in a bare `declaration` wrapper (same
 * as an abstract method above, so naturally excluded by the "bodied only"
 * rule); a constructor WITH a body IS wrapped in `method_definition` like an
 * ordinary method — BUT `constructor_signature`'s `name:` field is declared
 * `multiple: true` in node-types.json (accepting `.`/`identifier`/`new`
 * tokens), and a real parse of a NAMED constructor (`Foo.named(this.x)`)
 * confirmed this produces TWO separate captures under the SAME "name" field
 * label for one match (`Foo` and `named`) — which of the two ends up as
 * `runTagQuery`'s single `name` variable depends on capture-list ordering
 * behavior this file did not verify rigorously enough to trust, and getting
 * it wrong would silently mis-name or mis-collide constructors rather than
 * simply omit them. Given constructor bodies are usually thin
 * (initializer-list-style assignment, not business logic worth graphing),
 * the cost of leaving this undone is low; captured here as an explicit,
 * documented gap rather than a fragile guess.
 *
 * -- calls ----------------------------------------------------------------
 *
 * THREE call shapes, one pattern each: bare (`helper(x)`,
 * `call_expression function: (identifier)`), member (`obj.method(x)`,
 * `call_expression function: (member_expression (_) member: (identifier))`
 * — a wildcard on the receiver side is required and verified necessary for
 * chained access, `a.b.c(x)`, whose outer `member_expression`'s `object:`
 * field is itself a nested `member_expression`, not a bare identifier, the
 * same finding as Kotlin's chained-navigation case), and null-aware member
 * (`obj?.method(x)`) — Dart's `?.` produces a GENUINELY SEPARATE node type,
 * `conditional_member_expression`, not merely a different operator token
 * within the same `member_expression` node the way one might assume from
 * Ruby's `&.`/Kotlin's `?.` precedent — confirmed against a real parse this
 * needs its own dedicated pattern, not an operator alternation.
 *
 * **Dart's cascade operator (`obj..method1(x)..method2(y)`) needed NO
 * dedicated pattern at all — a genuinely pleasant surprise, found by
 * verifying rather than assuming it would need one like Kotlin's trailing-
 * lambda widening did.** Verified against a real parse: `cascade receiver:
 * (identifier) (cascade_section (call_expression function: (identifier)
 * ...))` — each `cascade_section`'s nested `call_expression` references the
 * method by a BARE `identifier` (the cascade's own `receiver:` field
 * supplies the implicit receiver separately, at the OUTER `cascade` node,
 * not restated inside each section) — meaning this file's existing bare-call
 * pattern already matches every cascade section for free. A cascade
 * section's own call site is still correctly attributed to its enclosing
 * function by range containment (the whole cascade statement, receiver
 * included, sits inside the same enclosing function body) — nothing lost.
 *
 * -- Dart-specific false-positive risks explicitly named in the task,
 * evaluated one at a time -------------------------------------------------
 *
 * **Named arguments** (a CORE Dart feature, not an edge case — `foo(handler:
 * x)` is used constantly, e.g. every Flutter widget constructor):
 * `named_argument` is a WHOLLY SEPARATE node type from `argument` in this
 * grammar (`named_argument name: (label (identifier)) value: (...)`),
 * unlike PHP/Kotlin's optional-field-on-the-same-node-type shape — verified
 * against a real parse of `foo(handler: x, path: y)` that this file's
 * by-reference pattern, `(arguments (argument (identifier) @arg))`, matches
 * NOTHING (named_argument nodes are never children matched by a pattern
 * requiring literally `argument`), with no anchor or negated-field
 * predicate needed at all — the cleanest structural exclusion of the three
 * languages in this batch, precisely because named arguments get their own
 * distinct node type here rather than sharing one with positional args.
 *
 * **Cascade syntax** (`..method()`): handled above — no special exclusion
 * needed, the bare-call pattern already covers it correctly, and no
 * over-capture risk was found (a cascade section's call is a real call,
 * same as a non-cascade one).
 *
 * **Null-aware operators** (`?.`/`??`): `?.` handled by the dedicated
 * `conditional_member_expression` pattern above. `??` (`if_null_expression`)
 * is NOT call-shaped at all — verified against a real parse of `var x = a ??
 * b;` — so it needs no exclusion, it simply never matches any call pattern.
 *
 * -- found during this file's development, not named in the original task —
 * TWO further Dart-specific findings ---------------------------------------
 *
 * **Class instantiation IS ambiguous with a call here, unlike PHP** (shared
 * limitation with Python/Go/Kotlin/Rust — see each one's own module doc
 * comment): modern Dart style omits the optional `new` keyword almost
 * universally, so `Foo(x)` (instantiating `Foo`) parses to the exact same
 * `call_expression function: (identifier)` shape as a real call — confirmed
 * against a real parse — making this ambiguity MORE common in practice here
 * than in languages where an explicit keyword is still typical, since
 * omitting `new` is the dominant real-world style, not a rare shorthand.
 * The explicit `new Foo(x)` spelling, by contrast, parses to a DIFFERENT
 * node, `new_expression`, which this file's call patterns do not match at
 * all — so only the (now-dominant) keyword-less style carries the
 * ambiguity. Same mitigation as every other language sharing this
 * limitation: `@definition.class` captures never enter the bare-name
 * `Function` index CALLS resolution reads from, so this only fabricates a
 * wrong edge when an unrelated function happens to share the exact name of
 * a class elsewhere in the indexed corpus.
 *
 * **Explicit generic-type-argument calls are NOT ambiguous here, unlike
 * Kotlin** — a positive contrast worth stating explicitly given how much
 * this exact shape cost Kotlin/Rust/C++ (see their own module doc comments):
 * `identity<int>(5)` was verified against a real parse to parse CORRECTLY as
 * an ordinary `call_expression`, whose `argument_part` simply contains BOTH
 * a `type_arguments` child and an `arguments` child side by side — no
 * turbofish-style separate node type, no `<`/`>`-vs-comparison grammar
 * ambiguity the way Kotlin's grammar has. This file's existing bare-call
 * pattern already captures `identity` correctly with no extra pattern
 * needed.
 *
 * -- comment node types (THREE, not the usual one — required an engine
 * change) -------------------------------------------------------------------
 *
 * `//` and a plain `/* *\/` block both produce the ordinary `comment` node
 * (unlike Java's/Rust's line/block split), but a DOC comment — either the
 * triple-slash `///` line form OR a `/** *\/`-style (double-asterisk-open)
 * block form, BOTH verified against real parses, a correction from this
 * file's first draft which only checked the `///` spelling — is its OWN
 * distinct node type, `documentation_comment`, not unified with plain
 * `comment` at all. An extremely common convention in real Dart (`dartdoc`),
 * and a very plausible place for a real project to write `/// implements
 * XSPEC-NNN` (or the block-doc equivalent). This REQUIRED an engine change:
 * `documentation_comment` has been added to tag-query-engine.ts's
 * `COMMENT_NODE_TYPES` (see that file's own doc comment) — without it, a
 * doc-comment-style implements-comment (either spelling) in a `.dart` file
 * would silently produce zero IMPLEMENTS edges, the exact Java-style silent
 * gap that Set exists to prevent.
 */
export const DART_TAGS_QUERY = `
; -- class / mixin / extension definitions ---------------------------------

(class_definition name: (identifier) @name) @definition.class
(mixin_declaration name: (identifier) @name) @definition.class
(extension_declaration name: (identifier) @name) @definition.class

; -- function / method definitions (outer wrapper captured for full range,
; name pulled from the nested signature — see module doc comment) ------------

(function_definition (function_signature name: (identifier) @name)) @definition.function
(method_definition (method_signature (function_signature name: (identifier) @name))) @definition.function
(method_definition (method_signature (getter_signature name: (identifier) @name))) @definition.function
(method_definition (method_signature (setter_signature name: (identifier) @name))) @definition.function

; TOP-LEVEL getters/setters (\`int get answer => 42;\` / \`set answer(int v)
; {...}\`, outside any class) — found by adversarial review, a real,
; previously-undocumented silent gap: these use a THIRD and FOURTH wrapper
; shape, \`getter_definition\`/\`setter_definition\` (bare, unlabeled children,
; mirroring \`function_definition\`'s own shape), NOT \`method_definition
; (method_signature (...))\` the way a CLASS member getter/setter is wrapped
; — confirmed against a real parse that neither of the two patterns above
; matched a top-level getter/setter at all (zero definition captures; a
; real Dart library idiom, e.g. Flutter's top-level \`defaultTargetPlatform\`
; getter, would have been silently invisible to this engine).
(getter_definition (getter_signature name: (identifier) @name)) @definition.function
(setter_definition (setter_signature name: (identifier) @name)) @definition.function

; nested/local function declarations, e.g. \`void outer() { void inner() {} }\`.
(local_function_declaration (lambda_expression parameters: (function_signature name: (identifier) @name))) @definition.function

; a closure/arrow-function literal bound to a variable or field:
; \`var log = (String m) { print(m); };\` / \`var log = (String m) => print(m);\`.
(initialized_identifier name: (identifier) @name value: (function_expression)) @definition.function

; -- calls -------------------------------------------------------------------

; bare: \`helper(x)\`. Also matches cascade-section calls (\`obj..method(x)\`)
; for free, and bare-invocation instantiation (\`Foo(x)\`) — a verified,
; shared, NOT-excludable Open Question with Python/Go/Kotlin/Rust — see
; module doc comment. Also correctly matches explicit generic-type-argument
; calls (\`identity<int>(5)\`) with no extra pattern needed, unlike Kotlin.
(call_expression function: (identifier) @name) @reference.call

; \`.\` : \`obj.method(x)\`, any receiver, any chain depth (wildcard required
; for chained access — verified, see module doc comment).
(call_expression function: (member_expression (_) member: (identifier) @name)) @reference.call

; \`?.\` : \`obj?.method(x)\` — a SEPARATE node type in this grammar
; (conditional_member_expression), not an operator alternation on
; member_expression — see module doc comment.
(call_expression function: (conditional_member_expression (_) member: (identifier) @name)) @reference.call

; a function/Closure passed *by reference* as a direct positional call
; argument (mirrors JS/Go/Python/Rust/Kotlin/C#/Ruby/PHP's equivalent
; pattern). Named arguments (\`foo(handler: x)\`) are a WHOLLY SEPARATE node
; type (named_argument, not argument) in this grammar and are excluded for
; free — the cleanest structural exclusion of this batch, no anchor or
; predicate needed — see module doc comment.
(arguments (argument (identifier) @reference.call.arg))
`;

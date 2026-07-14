/**
 * Go tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333 R2c.
 * Same capture-naming convention as javascript.ts/csharp.ts
 * (`@definition.function`, `@definition.class`, `@name`, `@reference.call`,
 * `@reference.call.arg`). Node-type names below were read from
 * `tree-sitter-go`'s `src/node-types.json` (0.23.4 — see grammars.d.ts's doc
 * comment for why this version is pinned) and verified against real parses
 * via `Parser.Query.matches`, not guessed. This file went through one round
 * of adversarial self-review after the first draft (mirroring C#'s R2b
 * process) that caught two real bugs described below (the func-literal
 * cross-pairing false positive, and an inconsistent "impossible to qualify"
 * framing) before being finalized.
 *
 * -- definitions --------------------------------------------------------------
 *
 * `function_declaration` (name field: `identifier`) is a package-level
 * function. `method_declaration` is a *distinct* node type for a function
 * with a receiver (`func (c *Calculator) Compute(x int) int {...}`) — note
 * its `name` field is a **`field_identifier`**, not a plain `identifier`
 * (confirmed against node-types.json), a different concrete node type than
 * `function_declaration`'s name field, so it needs its own pattern.
 *
 * A func literal (Go's anonymous function, `func(m string) {...}`) bound to
 * a variable mirrors the JS/C# "value bound to a variable" pattern, through
 * two binding forms: `short_var_declaration` (`log := func(...){}`) and
 * `var_spec` (`var log = func(...){}`). Both forms' relevant fields are
 * *wrapper* lists (`expression_list` for `short_var_declaration`'s
 * `left`/`right`; `var_spec`'s `value` — its `name` field is a bare
 * `identifier` for the single-name case but is `multiple: true` in the
 * grammar, i.e. can repeat for `var a, b = ...`), not a single paired
 * `name:`/`value:` field the way JS's `variable_declarator` works.
 *
 * **Adversarial-review-caught bug, fixed before this file was finalized**: a
 * naive first-draft pattern like `(short_var_declaration left:
 * (expression_list (identifier) @name) right: (expression_list
 * (func_literal) @definition.function))` — with no anchor — was confirmed
 * against a real parse to **cross-pair every identifier in `left` with every
 * func_literal in `right`**, independent of position: for a multi-value
 * declaration `a, f := 1, func(){}`, it wrongly captured `a` as the *name* of
 * the func literal (in addition to the correct `f`) — a fabricated Function
 * definition with the wrong name, confirmed as an actual match via
 * `Query.matches`, not a hypothetical. The fix (below) anchors both sides
 * with `.` (tree-sitter's "no sibling before/after" anchor) so the pattern
 * only matches when `left`/`right` each hold *exactly one* element — i.e.
 * only the single-name/single-value case. A multi-value declaration mixing a
 * func literal with other targets is consequently not captured at all
 * (verified: the anchored pattern produces zero matches against the
 * multi-value case) — a deliberate, verified false-negative (miss the rare
 * multi-assignment case entirely) rather than risk a wrong pairing, the same
 * precision-over-recall tradeoff as this codebase's other exclusions.
 *
 * -- Go type/struct/interface declarations as `@definition.class` ---------
 *
 * Go has no `class` keyword; the nearest analogues are `struct_type` and
 * `interface_type` (via `type_declaration > type_spec`). Captured here as
 * `@definition.class` (low-cost bonus scope, same rationale as C#'s
 * struct/interface/record capture) for graph completeness (`egr top Class`,
 * symbol search, cross-language parity — a Go-indexed repo would otherwise
 * be the only language on this engine with zero Class nodes) — this capture
 * can *never* contribute a false CALLS edge (`@definition.class` never
 * participates in call resolution), so there is no precision downside to
 * including it.
 *
 * This is **not**, however, useful for scope-*qualification* the way a C#
 * class is: verified against a real parse that a Go method's
 * `method_declaration` is a **top-level sibling** of its receiver type's
 * `type_declaration` elsewhere in the file — never lexically nested inside
 * it (there is no Go syntax where a method body is textually inside its
 * type's declaration) — so the tag-query engine's range-containment
 * `qualifyFunctions` has nothing to qualify against here regardless of
 * whether the type is captured as a Class node. Every Go method's id is
 * therefore qualified by method name alone (`file#MethodName`, not
 * `file#TypeName.MethodName`).
 *
 * **This is a real, not fundamental, limitation** — first-draft reasoning
 * for this file argued it was unfixable "by construction"; adversarial
 * self-review correctly rejected that framing as a false dichotomy: a
 * receiver's type name *is* mechanically readable from a `method_declaration`
 * node (`receiver: (parameter_list (parameter_declaration type:
 * [(type_identifier) | (pointer_type (type_identifier))]))`, confirmed
 * against a real parse for both value and pointer receivers), so a receiver-
 * qualified id (`file#Calculator.Compute`) *could* be built with a Go-
 * specific post-processing step in extractor.ts (reading each
 * `method_declaration` capture's own receiver field) without touching the
 * shared, language-agnostic `tag-query-engine.ts`. This was deliberately
 * **not implemented in this batch** — not because it is impossible, but
 * because of a real, separate limit it would *not* remove: a receiver-
 * qualified *definition* id does not by itself fix *call resolution*, which
 * still keys off the bare callee name captured at the call site
 * (`selector_expression`'s `field:` — see below) via a global bare-name
 * index; `x.Close()` would still resolve ambiguously (multiple candidates →
 * dropped, not silently wrong) whenever more than one type's `Close` method
 * exists in the indexed corpus, receiver-qualified ids or not. The
 * concrete, meaningful gain from doing it anyway would be: within a *single
 * file*, two different receiver types' same-named methods no longer
 * silently collapse onto one shared Function node/id (today they do — see
 * extractor.ts's comment on `qualifyFunctions`'s call site, and
 * `test/go.test.ts`'s regression test asserting this collapse, mirroring
 * `test/csharp.test.ts`'s overload-collapse test). Left as an Open Question
 * for a follow-up batch to weigh that gain against the extractor.ts
 * complexity of a language-specific id-rewrite step.
 *
 * -- calls ---------------------------------------------------------------------
 *
 * `call_expression function: (identifier)` is a bare call; `call_expression
 * function: (selector_expression field: (field_identifier))` is
 * `obj.Method(...)` / `pkg.Func(...)` (Go has no receiver keyword like
 * `this`, and package-qualified calls use the same `selector_expression`
 * shape) — the "operand" (receiver/package) field is deliberately
 * unconstrained, same permissiveness as the other languages' member-call
 * patterns.
 *
 * -- Go-specific false-positive risk found during this file's development,
 * not named in the original task (analogous to C#'s nameof/named-argument
 * lessons) — **type conversion syntax is grammatically identical to a call**
 * --------------------------------------------------------------------------
 *
 * Go's type-conversion syntax `T(x)` (e.g. `int(x)`, `string(x)`, a
 * user-defined `Celsius(x)`) parses to the *exact same shape* as a real call
 * — `call_expression function: (identifier) arguments: (argument_list
 * (identifier))` — confirmed against a real parse comparing `int(x)` and
 * `Helper(x)` side by side: tree-sitter is a pure syntax parser with no type
 * information, so it cannot and does not distinguish "calling a function
 * named T" from "converting x to type T" when T is a bare identifier. Two
 * different remediations, chosen per how bounded the risk is:
 *
 *  1. Go's **predeclared/builtin type names** (`bool`, `byte`, `complex64`,
 *     `complex128`, `error`, `float32`, `float64`, `int`, `int8`/`16`/`32`/
 *     `64`, `rune`, `string`, `uint`, `uint8`/`16`/`32`/`64`, `uintptr`,
 *     `any`) are a small, fixed, enumerable set that will essentially never
 *     also be a real user function name — excluded via a `#not-any-of?`
 *     predicate (confirmed this tree-sitter binding version's `Query`
 *     engine supports it and rejects unknown predicate names outright at
 *     construction time rather than silently ignoring them — read
 *     `node_modules/tree-sitter/index.js`'s predicate dispatch, which
 *     throws `Unknown query predicate` for anything unrecognized — then
 *     verified end-to-end that `int(x)` is excluded while `Helper(x)`
 *     remains, not assumed from the grammar docs alone) so `int(x)`/
 *     `string(x)`/etc. are never captured as a spurious `@reference.call`.
 *     Deliberately excludes only type-conversion-relevant identifiers, not
 *     Go's other predeclared *functions* (`len`, `cap`, `append`, `make`,
 *     `min`, `max`, `new`, `panic`, `recover`, ...) — those really are
 *     callable, and a pre-Go-1.21 codebase defining its own `min`/`max`
 *     helper would have a real call site excluded if they were lumped in
 *     with the type names.
 *  2. A **user-defined** type conversion (`Celsius(x)`, or package-qualified
 *     `time.Duration(x)` via the selector-expression variant) is an *open,
 *     unbounded* namespace — it cannot be enumerated or pattern-excluded the
 *     way the builtin list can. This is left as a documented, structural
 *     Open Question, grouped with Python's exactly-analogous
 *     `Foo()`-constructor-vs-call ambiguity (see queries/python.ts) since
 *     both are the same underlying limitation, not two unrelated language
 *     quirks: within Go's own scoping rules a type and a function can never
 *     share a name in the *same* package (compile error), so this can only
 *     ever fabricate a wrong CALLS edge when a conversion in one package
 *     happens to share a name with an unrelated real function defined in
 *     some *other* indexed package — a real but narrow risk this engine's
 *     pure-syntax analysis has no way to close without semantic type
 *     information (out of scope, same category as C#'s `obj.Method<T>()`
 *     Open Question).
 *
 * One case was checked and found to be a **desirable true positive, not a
 * false positive** — Go's idiom for satisfying a functional interface type
 * by converting a plain func value, e.g. `http.HandlerFunc(myHandler)` — is
 * *also* syntactically a "type conversion", but here the argument
 * (`myHandler`) genuinely is a real function being referenced by value (the
 * conversion only type-checks because `myHandler` already has a compatible
 * func signature) — this is the Go analogue of the by-reference-argument
 * pattern below, not a false capture, so the by-reference-argument pattern
 * (which does not use the builtin-type-name guard) is left free to capture
 * it.
 *
 * **Also found, not fixed — one specific explicit-type-argument generic call
 * shape is not `call_expression` at all**: this grammar has a genuine parse
 * ambiguity (matching a known ambiguity in Go's own spec, not a
 * tree-sitter-go bug) between "generic function call with an explicit type
 * argument" and "instantiate a generic type alias, then type-convert" —
 * `Identity[int](5)` (exactly one type argument, exactly one value argument)
 * was confirmed against a real parse to produce a `type_conversion_expression`
 * node (`type: (generic_type type:(type_identifier) type_arguments:(...))
 * operand: (int_literal)`), not `call_expression` — none of the patterns
 * below match it regardless of the callee name, so this specific shape is a
 * false negative (missed entirely). This is narrower than it first appears:
 * confirmed against real parses that *every other arity* parses correctly as
 * an ordinary `call_expression` with a `type_arguments` field (which this
 * file's patterns already tolerate, since they don't constrain against
 * extra fields) — zero value arguments (`Zero[int]()`), two-or-more type
 * arguments (`Map[int, int](f, xs)`), and the fully type-inferred form with
 * no brackets at all (`Map(f, xs)`) were all individually verified to
 * produce `call_expression` and be captured normally. Documented as an Open
 * Question, not fixed (same "rare syntax form, precision over recall"
 * category as the other exclusions in this file).
 *
 * -- by-reference call arguments (the Go analogue of the JS Fastify
 * `app.register(pluginFn, opts)` pattern) — e.g. `http.HandleFunc("/x",
 * handlerFunc)`, `http.HandlerFunc(myHandler)` above -----------------------
 *
 * A bare identifier that is a direct (non-nested) child of `argument_list`
 * counts, same "positional and non-nested only" cut as the other languages.
 * No named-argument-style guard is needed: Go has no named/keyword call
 * arguments at all (confirmed against node-types.json — `argument_list`'s
 * children are plain `_expression`/`_type`/`variadic_argument`, no
 * "labeled argument" wrapper node type the way C#/Python have).
 */
export const GO_TAGS_QUERY = `
; -- function / method definitions --------------------------------------------

(function_declaration name: (identifier) @name) @definition.function

(method_declaration name: (field_identifier) @name) @definition.function

; a func literal bound to a variable via ":=": \`log := func(m string) {...}\`.
; Anchored to the single-name/single-value case only — see module doc
; comment for the cross-pairing false positive this anchor fixes.
(short_var_declaration
  left: (expression_list . (identifier) @name .)
  right: (expression_list . (func_literal) @definition.function .))

; the "var" form of the same pattern: \`var log = func(m string) {...}\`.
; Same single-element anchor, for the same reason (var_spec's "name" field
; can also repeat for \`var a, b = ...\`).
(var_spec
  name: (identifier) @name .
  value: (expression_list . (func_literal) @definition.function .))

; -- struct / interface type definitions (low-cost bonus scope; see module
; doc comment for why this does NOT help scope-qualify methods) --------------

(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.class

(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.class

; -- calls ---------------------------------------------------------------------

; \`Helper(...)\` — excludes Go's predeclared/builtin type names, which parse
; identically to a call when used as a type conversion (\`int(x)\`) — see
; module doc comment. A genuine user-defined type conversion (\`Celsius(x)\`)
; is NOT excluded (open, unbounded namespace — documented Open Question).
(call_expression
  function: (identifier) @_callee @name
  (#not-any-of? @_callee
    "bool" "byte" "complex64" "complex128" "error"
    "float32" "float64"
    "int" "int8" "int16" "int32" "int64"
    "rune" "string"
    "uint" "uint8" "uint16" "uint32" "uint64" "uintptr"
    "any")) @reference.call

; \`obj.Method(...)\` / \`pkg.Func(...)\` — any operand (receiver or package).
(call_expression
  function: (selector_expression
    field: (field_identifier) @name)) @reference.call

; a function passed *by reference* as a direct (non-nested) call argument,
; e.g. \`http.HandleFunc("/x", handlerFunc)\`. No named-argument guard needed
; — Go has no labeled call arguments (see module doc comment).
(call_expression
  arguments: (argument_list (identifier) @reference.call.arg))
`;

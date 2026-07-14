/**
 * C# tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333 R2b,
 * the first non-JS/TS language on the generic tag-query engine
 * (tag-query-engine.ts), proving the engine actually generalizes rather than
 * being JS/TS-shaped in disguise. Same capture-naming convention as
 * javascript.ts/typescript.ts (`@definition.function`, `@definition.class`,
 * `@name`, `@reference.call`, `@reference.call.arg`) — see that file's doc
 * comment for the convention's origin. Node-type names below were read from
 * `tree-sitter-c-sharp`'s `src/node-types.json` (0.23.1 — see grammars.d.ts's
 * doc comment for why this specific version is pinned) and verified against
 * real parses, not guessed.
 *
 * -- definitions --------------------------------------------------------------
 *
 * `class_declaration`, `struct_declaration`, `interface_declaration` and
 * `record_declaration` all share the same relevant shape in node-types.json
 * (`name: (identifier)`, optional `body: (declaration_list)` — required for
 * the first three, optional for `record_declaration` since a body-less
 * record like `record Point(int X, int Y);` is legal) — unlike JS/TS there
 * is no per-kind field difference to reason about, so unlike the task's
 * minimum ask (class_declaration only) all four are captured as
 * `@definition.class` here at effectively zero marginal cost. A record's
 * *primary constructor* parameter list (`record Point(int X, int Y);`) is a
 * bare child of record_declaration, not a constructor_declaration — it has no
 * body to walk for calls, so nothing is lost by not special-casing it.
 *
 * `method_declaration`'s `name` field is always a plain `identifier` in this
 * grammar (no computed/private/string/numeric method-name forms like JS) —
 * no wildcard needed. Its `body` field is optional (interface method
 * signatures and abstract methods have none); those are still captured as
 * Function nodes (a nameable, qualifiable symbol) — they simply never
 * contribute a call site, since there is no body to search.
 *
 * `constructor_declaration` is a distinct node type from `method_declaration`
 * in this grammar (JS/TS have no equivalent split — a JS class's
 * `constructor(){}` is just a method_definition named "constructor"). Its
 * `name` field repeats the class name, so a class `Foo`'s constructor
 * qualifies to `file#Foo.Foo` — a documented quirk, not a bug: it is the
 * literal ctor identifier tree-sitter reports, and keeping it (rather than
 * renaming to a synthetic "constructor") preserves this file's "declare, don't
 * hand-massage" design.
 *
 * `local_function_statement` is C#'s nested named function inside a method
 * body (`int Helper(int n) { ... }` declared inside another method) — the
 * closest C# analogue to JS's nested `function` declarations; same shape
 * (`name`, `body`) so captured the same way.
 *
 * A lambda bound to a local variable (`Action<int> log = (m) => ...;`)
 * mirrors JS's "arrow function bound to a variable_declarator" pattern, but
 * C#'s `variable_declarator` holds the initializer as an *anonymous* child
 * (no "value:" field — confirmed against a real parse), so the pattern
 * anchors on the bare child node instead of a field name.
 *
 * -- calls ----------------------------------------------------------------
 *
 * `invocation_expression function: (identifier)` is a bare call
 * (`Helper()`); `invocation_expression function: (member_access_expression
 * name: (identifier))` is `obj.Method()` / `this.Method()` — the
 * `member_access_expression`'s "expression" (receiver) field is deliberately
 * not constrained, so any receiver (`this`, an identifier, a chained member
 * access, `Console`, …) matches, same permissiveness as the JS pattern.
 *
 * `member_access_expression`'s "name" field can also be a `generic_name`
 * (`obj.Method<T>()`) — NOT captured here (see this file's module doc /
 * task Open Questions): resolving it would need to reach into the
 * generic_name's own identifier child rather than using its raw text (which
 * includes the `<T>` and would never match a plain method name in the
 * global name index), a materially different pattern than "copy the JS
 * shape" — left as a follow-up rather than forced in for R2b.
 *
 * The by-reference-argument analogue of JS's `@reference.call.arg`
 * (`app.register(pluginFn, opts)`) is a C# "method group" passed as a bare
 * identifier argument (`app.Register(ConfigureAlerts, options)` — C#
 * implicitly converts a bare method name to a delegate in that position).
 * Same shape as JS: only a direct (non-nested) bare identifier under
 * `argument_list` counts — but two C# constructs that don't exist in JS
 * make a naive port of the JS pattern (`argument_list (argument
 * (identifier))`, no further constraint) produce false CALLS edges, both
 * confirmed against a real parse before being excluded here:
 *
 *  1. A *named argument* (`Foo(handler: 1)`) puts the parameter label
 *     itself in `argument`'s optional `name:` field as a plain
 *     `identifier` — indistinguishable from a real positional bare-name
 *     argument unless the pattern explicitly requires the `name:` field to
 *     be *absent* (`!name`). Without it, calling a method with a parameter
 *     literally named after some other real function in scope (e.g.
 *     `Foo(handler: 1)` where a `handler()` method also exists) fabricates
 *     a CALLS edge to `handler` — confirmed against a real parse. This also
 *     means a named argument whose *value* is itself a bare-identifier
 *     method-group reference (`app.Register(handler: ConfigureAlerts)`) is
 *     NOT captured either — the whole `argument` node has a `name:` field,
 *     so `!name` excludes it wholesale, the same narrowing tradeoff (miss a
 *     rarer positive rather than admit a wrong one) as JS's own "only a
 *     *direct* argument, not one nested in an object/array literal" cut.
 *  2. `nameof(X)` is ordinary syntax to this grammar — an
 *     `invocation_expression` whose callee is the identifier `nameof` and
 *     whose sole argument is a bare identifier `X` — but semantically it
 *     is a *symbol reference*, not a call or a value-pass, and is common
 *     idiomatic C# (argument validation, logging, `nameof(SomeMethod)`).
 *     Confirmed against a real parse that the naive pattern fabricates a
 *     CALLS edge to `X` whenever `X` happens to name a real function.
 *     Excluded via a `#not-eq?` predicate on the invocation's callee name
 *     (this binding's `Query.matches`/`.captures` does evaluate
 *     `#eq?`/`#not-eq?`/`#match?` predicates itself — confirmed by reading
 *     node_modules/tree-sitter/index.js — so this is not dead weight in
 *     the query string). `nameof` can only ever be a bare-identifier call
 *     (there is no `obj.nameof(x)` in C#), so the member-access variant of
 *     this pattern needs no equivalent guard.
 */
export const CSHARP_TAGS_QUERY = `
; -- class / struct / interface / record definitions ------------------------

(class_declaration name: (identifier) @name) @definition.class

(struct_declaration name: (identifier) @name) @definition.class

(interface_declaration name: (identifier) @name) @definition.class

(record_declaration name: (identifier) @name) @definition.class

; -- function definitions ----------------------------------------------------

(method_declaration name: (identifier) @name) @definition.function

(constructor_declaration name: (identifier) @name) @definition.function

(local_function_statement name: (identifier) @name) @definition.function

; a lambda bound to a local variable: \`Action<int> log = (m) => ...;\`. The
; initializer is an anonymous child of variable_declarator in this grammar
; (no "value:" field, unlike JS) — verified against a real parse.
(variable_declarator
  name: (identifier) @name
  (lambda_expression) @definition.function)

; -- calls ---------------------------------------------------------------------

; \`Helper(...)\`
(invocation_expression function: (identifier) @name) @reference.call

; \`obj.Method(...)\` / \`this.Method(...)\` — any receiver, callee = plain
; identifier member name (generic_name callees like \`obj.Method<T>()\` are
; intentionally not captured — see module doc comment).
(invocation_expression
  function: (member_access_expression
    name: (identifier) @name)) @reference.call

; a method group passed *by reference* as a direct (non-nested) call
; argument, e.g. \`app.Register(ConfigureAlerts, options)\` — the C# analogue
; of JS's Fastify \`app.register(pluginFn, opts)\` pattern. "!name" excludes
; a named-argument label (\`Foo(handler: 1)\`, itself a plain identifier in
; this grammar); "#not-eq?" excludes \`nameof(X)\` (a symbol reference, not a
; call/value-pass) — both fabricate a CALLS edge without these guards, see
; module doc comment. Two variants: bare-identifier callee (needs the
; nameof guard) and member-access callee (nameof can never be
; member-accessed, so no guard needed there).
(invocation_expression
  function: (identifier) @_callee
  arguments: (argument_list (argument !name (identifier) @reference.call.arg))
  (#not-eq? @_callee "nameof"))

(invocation_expression
  function: (member_access_expression)
  arguments: (argument_list (argument !name (identifier) @reference.call.arg)))
`;

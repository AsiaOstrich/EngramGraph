/**
 * Java tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333
 * R2c. Same capture-naming convention as javascript.ts/csharp.ts
 * (`@definition.function`, `@definition.class`, `@name`, `@reference.call`,
 * `@reference.call.arg`). Node-type names below were read from
 * `tree-sitter-java`'s `src/node-types.json` (0.23.5 — see grammars.d.ts's
 * doc comment for why this version is pinned) and verified against real
 * parses via `Parser.Query.matches`, not guessed. This file went through one
 * round of adversarial self-review after the first draft (mirroring C#'s
 * R2b process) that caught a real anchoring bug in the lambda-binding
 * pattern (below) before being finalized.
 *
 * -- calls ---------------------------------------------------------------------
 *
 * `method_invocation` **unifies** bare calls and member calls into a single
 * node type — its `object` field is *optional* (present for `obj.method()`,
 * absent for bare `foo()`), and its `name` field is *always* a plain
 * `identifier` regardless (confirmed against node-types.json and a real
 * parse). This is simpler than every other language on this engine so far:
 * JS/C#/Go all need two separate patterns (bare-identifier callee vs.
 * member-access callee, two different node shapes) because their grammars
 * use different node types for the two forms; Java needs only one pattern
 * here because its grammar already unifies them.
 *
 * -- definitions --------------------------------------------------------------
 *
 * `method_declaration` (name: `identifier`, body: optional — interface
 * methods and abstract methods have none, same as C#'s equivalent case) and
 * `constructor_declaration` (a *distinct* node type from
 * `method_declaration`, same split as C#) both map to `@definition.function`.
 * `constructor_declaration`'s `name` field repeats the class name — the same
 * documented quirk as C#'s constructor (a class `Greeter`'s constructor
 * qualifies to `file#Greeter.Greeter`), not a bug, kept for the same
 * "declare, don't hand-massage" reason.
 *
 * `class_declaration`, `interface_declaration`, `enum_declaration`,
 * `record_declaration` (Java 16+) and `annotation_type_declaration`
 * (`@interface Foo {}`) all share the same relevant shape (`name:
 * (identifier)`, a required body field) — captured together as
 * `@definition.class`, the same "low-cost bonus scope" rationale as C#'s
 * struct/interface/record capture (this file's task minimum only asked for
 * `class_declaration`/`interface_declaration`).
 *
 * A lambda bound to a variable (`Runnable log = () -> ...;`) is captured via
 * `variable_declarator name: (identifier) value: (lambda_expression)`.
 * **Adversarial-review-caught bug, fixed before this file was finalized**: the
 * first draft anchored this pattern on `local_variable_declaration
 * declarator: (variable_declarator ...)` (mirroring how the pattern reads
 * most naturally as "a *local* variable holding a lambda"), but this was
 * confirmed against a real parse to **miss every field-bound lambda**
 * entirely — `private Runnable fieldLambda = () -> ...;` (a `field_declaration`,
 * not `local_variable_declaration`) produced zero matches under that
 * anchor, even though field-bound functional-interface values are extremely
 * common in real Java (dependency-injected callbacks, listener fields,
 * `Comparator` constants, etc.). The fix anchors directly on
 * `variable_declarator` itself (no outer `local_variable_declaration`/
 * `field_declaration` wrapper) — verified against a real parse that this
 * single pattern correctly captures both the local and the field case,
 * since both wrap the same `variable_declarator` shape underneath (matching
 * C#'s own `variable_declarator`-anchored lambda pattern, which this draft
 * should have mirrored from the start rather than reasoning from the "it's
 * about locals" English description of the idiom).
 *
 * -- by-reference call arguments — Java's real idiom is `method_reference`,
 * NOT a bare identifier (a deliberate, considered deviation from every
 * other language on this engine) --------------------------------------------
 *
 * Every other language captured so far (JS, C#, Go, Python) has some form of
 * "pass an already-defined function by its bare name as a call argument"
 * (`app.register(pluginFn)`, `Register(ConfigureAlerts, opts)`,
 * `http.HandleFunc("/x", handlerFunc)`, `signal.signal(sig, handler_fn)`).
 * **Java structurally cannot do this**: a method name is not itself a value
 * in Java — passing a function as a value requires either a lambda or the
 * `Type::method` / `expr::method` *method reference* syntax (confirmed: a
 * bare method name used where a value is expected is not valid Java at
 * all). The true Java analogue of the by-reference-argument pattern is
 * therefore `method_reference` (`list.forEach(this::process)`,
 * `items.stream().map(String::toUpperCase)`), not a bare identifier — this
 * file captures *that*, not a bare-identifier pattern, as the intentional,
 * language-correct equivalent rather than a mechanical copy of the JS shape.
 *
 * `method_reference`'s two (or three, with an explicit type-argument list)
 * children are **anonymous** (no field names in this grammar — confirmed
 * against node-types.json, `"fields": {}`) — for `String::toUpperCase` this
 * means *both* `String` (the receiver type) and `toUpperCase` (the actual
 * method being referenced) are `identifier` children, and a naive
 * `(method_reference (identifier) @arg)` pattern was confirmed (via a real
 * `Query.matches` call) to capture **both**, wrongly treating the receiver
 * type name as a reference too. Fixed with tree-sitter's trailing anchor
 * (`(method_reference (identifier) @reference.call.arg .)` — the `.` before
 * the closing paren means "this must be the last child") — verified this
 * correctly keeps only the trailing method-name identifier (`toUpperCase`,
 * `process`, `println`) and drops the receiver (`String`) in all three real
 * test cases (`this::process`, `String::toUpperCase`,
 * `System.out::println`). The pattern is additionally scoped to only match
 * when the whole `method_reference` is a direct child of `argument_list`
 * (mirroring every other language's "direct, non-nested argument only"
 * cut) — confirmed a `method_reference` assigned to a variable
 * (`Runnable r = this::process;`, not passed as a call argument) is
 * correctly *not* captured by this scoping.
 *
 * **Considered and deliberately rejected: also adding a bare-identifier
 * pattern for Java, to mechanically mirror the other five languages.**
 * Verified against a real parse that Java's grammar *would* structurally
 * allow it (`list.forEach(r)` parses as an ordinary `argument_list`
 * containing a bare `identifier` `r`, exactly like every other language)
 * — but Java has a **separate namespace for methods and local
 * variables/parameters** (confirmed: `void filter() {}` and a parameter
 * `Object filter` coexist validly in the same class without error, and a
 * real parse of `doSomething(size, filter)` in that scenario captures both
 * `size` and `filter` as bare-identifier arguments), unlike JS's single
 * namespace where a name naturally shadows and a bare-identifier argument
 * is overwhelmingly likely to actually *be* the intended function reference.
 * Common short Java parameter/local names (`filter`, `handler`, `size`,
 * `value`, `listener`, `callback`) frequently collide by pure coincidence
 * with unrelated method names elsewhere in a real codebase, and — because a
 * method reference or lambda is *required* to genuinely pass a function by
 * value in Java — a bare identifier being passed as an argument is *never*
 * actually a function reference in valid Java (only ever a value: an int, a
 * String, an already-lambda-initialized variable of some functional-
 * interface type, etc.). The narrow legitimate case this rejects (`Runnable
 * r = this::process; list.forEach(r);` — passing a previously-bound
 * variable rather than the method reference literal at the call site) would
 * need dataflow/alias tracking to resolve correctly regardless (out of
 * scope for a per-call-site static pattern, the same reason no other
 * language on this engine attempts it) — so skipping the bare-identifier
 * pattern here trades a narrow, already-mostly-unreachable false-negative
 * for closing off a real, comparatively wide false-positive channel unique
 * to Java's dual namespace. This is a considered per-language design
 * decision, not an oversight — flagged here so a future contributor does
 * not "fix" it back in without re-deriving this tradeoff.
 */
export const JAVA_TAGS_QUERY = `
; -- class / interface / enum / record / annotation-type definitions --------

(class_declaration name: (identifier) @name) @definition.class

(interface_declaration name: (identifier) @name) @definition.class

(enum_declaration name: (identifier) @name) @definition.class

(record_declaration name: (identifier) @name) @definition.class

(annotation_type_declaration name: (identifier) @name) @definition.class

; -- function / constructor definitions ---------------------------------------

(method_declaration name: (identifier) @name) @definition.function

(constructor_declaration name: (identifier) @name) @definition.function

; a lambda bound to a variable (local OR field — see module doc comment for
; why this anchors directly on variable_declarator, not a wrapping
; local_variable_declaration/field_declaration).
(variable_declarator
  name: (identifier) @name
  value: (lambda_expression) @definition.function)

; -- calls ---------------------------------------------------------------------

; \`foo(...)\` / \`obj.foo(...)\` — this grammar unifies both shapes into one
; node type (see module doc comment); "object" is deliberately unconstrained.
(method_invocation name: (identifier) @name) @reference.call

; a method reference passed *by reference* as a direct (non-nested) call
; argument — Java's actual idiom for "pass a function as a value" (see
; module doc comment for why this replaces the bare-identifier pattern every
; other language on this engine has). The trailing "." anchor keeps only the
; referenced method name (e.g. "toUpperCase" in String::toUpperCase), not
; the receiver type/expression (e.g. "String").
(argument_list (method_reference (identifier) @reference.call.arg .))
`;

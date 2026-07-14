/**
 * C++ tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333
 * R2c batch 2. Same capture-naming convention as javascript.ts/csharp.ts/
 * go.ts/rust.ts (`@definition.function`, `@definition.class`, `@name`,
 * `@reference.call`, `@reference.call.arg`). Node-type names below were read
 * from `tree-sitter-cpp`'s `src/node-types.json` (0.23.4 — see
 * grammars.d.ts's doc comment for why this version is pinned) and verified
 * against real parses via `Parser.Query.matches`, not guessed. This
 * grammar's own shipped `queries/tags.scm` (a ctags-style reference query
 * every tree-sitter-cpp release includes) was read for orientation on which
 * node/field names to use, then independently re-verified against real
 * parses rather than copied verbatim — this file's patterns differ from it
 * in one structural way, described below.
 *
 * -- definitions: the function name is NOT a direct field of
 * `function_definition` — it is nested inside a `declarator` chain ---------
 *
 * Every other language on this engine has a `name:` field directly on its
 * function-defining node. C++ does not: `function_definition`'s only
 * relevant field is `declarator:`, whose value is a `function_declarator`
 * (itself holding the *actual* name in its own nested `declarator:` field,
 * one more level down). This file's patterns therefore nest one level
 * deeper than e.g. C#'s `(method_declaration name: (identifier) @name)`:
 * `(function_definition declarator: (function_declarator declarator: (...)
 * @name))`. Three concrete shapes for that inner declarator were verified
 * against real parses:
 *
 *  - `(identifier)` — a free function (`int square(int n) {...}`).
 *  - `(field_identifier)` — an inline method defined directly inside a
 *    `class_specifier`/`struct_specifier` body (`int compute(int x) {...}`
 *    written inside `class Calculator { ... }`).
 *  - `(qualified_identifier name: (identifier))` — an **out-of-line** method
 *    definition (`int Calculator::outOfLine(int x) {...}`), where
 *    `qualified_identifier`'s own `scope:` field holds the class/namespace
 *    qualifier and `name:` holds the actual method name (confirmed against a
 *    real parse: `outOfLine`, not `Calculator::outOfLine`, is what `name:`
 *    resolves to).
 *  - `(destructor_name)` — a destructor (`~Foo() {...}`). Captured as the
 *    **whole** `destructor_name` node (`@name` on `(destructor_name)`
 *    itself, not on some inner identifier child), so its captured name is
 *    the literal `~Foo` text, *not* `Foo` — a deliberate choice, not an
 *    oversight: `destructor_name`'s only child is a plain `identifier`
 *    holding just `Foo` (confirmed against node-types.json/a real parse,
 *    the `~` itself is an anonymous sibling token, not part of that child),
 *    so capturing that inner child instead would give the destructor the
 *    *exact same* bare name (`Foo`) as the class's own constructor —
 *    silently colliding two semantically distinct members (constructor vs.
 *    destructor) onto one qualified id (`file#Foo.Foo`), confirmed as a real
 *    collision by testing the inner-identifier capture before rejecting it.
 *    Capturing the whole node instead gives the destructor its own distinct
 *    name (`~Foo`, qualifying to `file#Foo.~Foo`) with no engine changes.
 *
 * **Two real gaps found by adversarial review (not the original development
 * pass), now fixed** — a `function_definition` whose return type is a
 * pointer or reference (`int* makePtr() {...}`, `Foo& withX(int x) {...}`,
 * including an out-of-line pointer/reference-returning method,
 * `Foo& Foo::outOfLine() {...}`) wraps the `function_declarator` in one more
 * layer — `pointer_declarator declarator: (function_declarator ...)` or
 * `reference_declarator (function_declarator ...)` (the former has a
 * `declarator:` field, confirmed against node-types.json; the latter has
 * none, so its pattern is positional) — a **fourth dimension** (wrapper:
 * none/pointer/reference) crossed with the three name shapes above, missed
 * entirely by this file's first draft (confirmed: zero matches for a
 * pointer-returning function before this fix, silently dropping both the
 * definition *and* every call site inside its body, since
 * `findEnclosingFunction` had no captured Function node to attribute them
 * to). Pointer/reference-returning functions are extremely common in real
 * C++ (this exact gap was found empirically against `google/leveldb`'s
 * `Status` class, not hypothesized — every one of its `bool` methods was
 * fine, but a pointer/reference-returning sibling would have been silently
 * invisible). Six additional patterns below cover all three name shapes
 * under both wrapper kinds.
 *
 * **One shape remains genuinely unhandled**: an operator overload
 * (`Status& operator=(const Status& rhs);`, found via the same leveldb
 * smoke testing) puts an `operator_name` node in the inner declarator
 * position — a concrete node type none of the patterns above match,
 * confirmed against a real parse of leveldb's own `operator=`. An operator
 * overload's *definition* is silently not extracted as a Function node at
 * all (see `test/cpp.test.ts`'s dedicated regression test demonstrating
 * this exact shape). Left unhandled in this batch — the task's minimum ask
 * was functions/methods/classes/calls/false-positive checks, and operator
 * overloads are a C++-only extra with their own further wrinkles (operator
 * *calls*, e.g. `a + b` invoking `operator+`, aren't `call_expression` at
 * all and would need their own separate investigation) — documented here as
 * an Open Question for a follow-up batch rather than rushed in
 * under-verified.
 *
 * Critically, `@definition.function` is attached to the **outer**
 * `function_definition` node in every pattern below, not to the inner
 * `function_declarator` (which this grammar's own `tags.scm` uses as the
 * anchor for ctags purposes) — `function_declarator`'s byte range covers
 * only the name + parameter list, **not** the function body, so anchoring
 * there would break this engine's range-containment logic
 * (`findEnclosingFunction` needs the full body in range to attribute a call
 * site inside it to the right function; `qualifyFunctions` needs the full
 * range to nest inline methods inside their enclosing class). Verified by
 * inspecting both nodes' byte ranges on a real parse before finalizing this
 * choice — a mechanical copy of `tags.scm`'s anchor point would have shipped
 * with silently broken call attribution for every function with a
 * non-trivial body.
 *
 * -- inline methods qualify to `Class.method` for free; out-of-line
 * definitions do not (documented, same category as Go's/Rust's Open
 * Questions, verified independently for C++, not assumed to match either) --
 *
 * `class_specifier`/`struct_specifier` (name: `type_identifier`, body:
 * optional `field_declaration_list` — optional because a forward
 * declaration like `class Foo;` has no body) are captured as
 * `@definition.class`. Verified against a real parse: a method defined
 * **inline**, directly inside the class body (the `field_identifier` name
 * shape above), sits lexically inside the class's own byte range, so the
 * shared `qualifyFunctions` range-containment logic qualifies it to
 * `file#Calculator.compute` with zero C++-specific extractor.ts code — the
 * same free win Rust's `impl`/`trait` blocks get (see queries/rust.ts's
 * module doc comment), and unlike Go's receiver methods, which never nest.
 * An **out-of-line** definition (`int Calculator::outOfLine(...) {...}`,
 * the `qualified_identifier` name shape above) is, by contrast, a top-level
 * sibling of the class — not lexically inside it — so it does *not* benefit
 * from this and qualifies to a bare `file#outOfLine`, the exact same
 * Go-style limitation. This file does not attempt to recover the
 * `Calculator::` qualifier from `qualified_identifier`'s own `scope:` field
 * to rewrite the id — left as a documented Open Question for the same
 * reason Go's file leaves its analogous case unfixed (would need a
 * C++-specific extractor.ts post-processing step; the concrete gain is
 * narrower than it looks, since CALLS resolution still keys off the bare
 * callee name via a global name index regardless of how precisely the
 * *definition* id is qualified).
 *
 * -- calls ---------------------------------------------------------------------
 *
 * Four call shapes, all via `call_expression`, verified against real parses.
 * **Correction (found by adversarial review — this file's first draft
 * claimed `call_expression` has "no field names at all", which is wrong and
 * was never actually checked against node-types.json for this specific
 * node)**: `call_expression` *does* have named fields — `function:` and
 * `arguments:` (confirmed by reading node-types.json directly: `"fields":
 * {"arguments": {...}, "function": {...}}`, and by a real parse printing
 * `childForFieldName("function")`/`childForFieldName("arguments")`
 * successfully) — this file's patterns below could have used `function:`
 * throughout, the same way `field_expression`'s `field:` is used just below.
 * They still work correctly written positionally (a call's callee is always
 * `call_expression`'s sole non-`argument_list` child, so there is no
 * ambiguity either way), but the field is there and the field-name form is
 * used for the new `qualified_identifier` pattern added below so this
 * mistake is not compounded going forward:
 *
 *  - `(identifier) @name` directly under `call_expression` — a bare call
 *    (`helper(x)`). Also matches C++'s "functional-style cast"/temporary-
 *    construction idiom (`Point(1, 2)`) — see the false-positive-risk
 *    section below.
 *  - `(field_expression field: (field_identifier) @name)` — `obj.method()` /
 *    `this->method()` (the `argument:`/receiver side and the `->`/`.`
 *    operator are both deliberately unconstrained — any receiver, either
 *    operator, matches, same permissiveness as every other language's
 *    member-call pattern).
 *  - `(template_function name: (identifier) @name)` /
 *    `(field_expression field: (template_method name: (field_identifier)
 *    @name))` — an explicit-template-argument call (`identity<int>(5)`,
 *    `b.get<int>()`). Verified against a real parse that these are genuinely
 *    *different* node shapes from the plain-identifier/field_identifier
 *    cases above (`call_expression`'s "function" position becomes a
 *    `template_function`/the `field_expression`'s `field:` becomes a
 *    `template_method`, wrapping — not replacing — the name), so both the
 *    plain and the explicit-template-argument forms need their own pattern;
 *    omitting these two would silently miss every explicitly-instantiated
 *    template call, which is common in real C++ (`std::get<0>(pair)`,
 *    `container.emplace<T>(...)`).
 *  - `function: (qualified_identifier name: (identifier) @name)` — a
 *    **namespace-qualified or static/associated call**
 *    (`ns::helper(x)`, `Foo::staticMethod()`, `std::move(x)`) — a **real gap
 *    found by adversarial review, not the original development pass**: this
 *    shape parses to `call_expression function: (qualified_identifier
 *    name: (identifier))` (confirmed against a real parse), which none of
 *    this file's first-draft patterns matched at all (zero captures for
 *    `ns::helper(x)` before this fix — its own by-reference-argument
 *    pattern still fired on `x`, capturing an argument for a call the file
 *    itself couldn't see, an inconsistency that was the tell). This is the
 *    C++ analogue of Rust's `scoped_identifier` pattern (see
 *    queries/rust.ts) — a shape this file's first draft, unlike Rust's,
 *    failed to anticipate despite C++ having the same `::` call syntax.
 *
 * -- C++-specific false-positive risk found during this file's development,
 * not named in the original task (the same underlying limitation as Go's
 * type-conversion ambiguity, Python's class-instantiation ambiguity and
 * Rust's tuple-struct-construction ambiguity — see those files' module docs
 * for the full writeup of this shared limitation) — **but C++ turns out to
 * split cleanly into a safe half and an unsafe half, verified, not
 * assumed** --------------------------------------------------------------
 *
 * `int(x)` (a **primitive-type** functional-style cast) was confirmed
 * against a real parse to make `call_expression`'s callee position a
 * `primitive_type` node — a **different, non-identifier node type** — so
 * this file's `(call_expression function: (identifier) @name)`-shaped
 * pattern (there is no `function:` field to write, so this is really "an
 * `identifier` appears where the callee position is", verified positionally)
 * excludes it *for free*, with **no `#not-any-of?`-style predicate needed**
 * — a real, verified difference from Go, whose builtin type names
 * (`int`, `string`, ...) parse as plain `identifier`s indistinguishable from
 * a real callee, forcing Go's file to enumerate and exclude them explicitly.
 * C++'s grammar itself already tells primitive-type casts apart from
 * identifier calls structurally.
 *
 * `Point(1, 2)` (constructing a class/struct via C++'s "functional-style
 * cast"/temporary-construction syntax, when `Point` is a **user-defined**
 * type) was confirmed against the same real parse to make the callee
 * position a plain `identifier` — indistinguishable from a real call to a
 * function named `Point`, the unsafe half. This is the C++ instance of the
 * shared limitation named above: no `#not-any-of?`-style fix is possible
 * here (user-defined type names are an open, unbounded namespace, the same
 * reasoning as Go's user-defined type-conversion case and Rust's tuple-
 * struct case).
 *
 * **C++ splits further than the other languages, verified rather than
 * assumed to match them**: for a class **with no user-defined constructor**
 * (e.g. `Empty()`), the mitigation is the same as Go/Rust/Python —
 * `@definition.class` captures never enter the bare-name `Function` index
 * CALLS resolution reads from, so this only produces a wrong edge if some
 * *other*, unrelated function happens to share that exact name elsewhere in
 * the indexed corpus (confirmed: `Empty()` resolves to nothing when `Empty`
 * has no constructor). But for a class **with** a user-defined constructor
 * (`Point(int x, int y) {}`), that constructor is *itself* an ordinary
 * `function_definition` this file's own patterns capture (the
 * `field_identifier` inline-method shape above; C++ constructors have no
 * distinct node type, and repeat the class name — the same documented
 * quirk C#/Java's constructors already have, e.g. `file#Point.Point`) — so
 * `Point(1, 2)` genuinely **does** resolve, to that exact constructor
 * (confirmed against a real extraction: the sole CALLS edge from a caller
 * targets `file#Point.Point`). This is **not a false positive at all**:
 * `Point(1, 2)` really does invoke `Point::Point(int, int)` at runtime, so
 * resolving it there is semantically correct — a pleasant, C++-specific
 * exception verified during this file's development, not one this file
 * arranges to happen (it falls out for free from constructors and calls
 * sharing the same "identifier + arguments" shape). Documented as an Open
 * Question only for the no-constructor case; the with-constructor case is a
 * verified correct behavior, not a risk.
 *
 * -- by-reference call arguments (the C++ analogue of the JS Fastify
 * `app.register(pluginFn, opts)` pattern) — e.g.
 * \`registerHandler("/x", handlerFunc)\` -----------------------------------
 *
 * A bare identifier that is a direct (non-nested) child of `argument_list`
 * counts, same "positional and non-nested only" cut as every other
 * language. No named-argument-style guard is needed: C++, like Go/Rust, has
 * no named/keyword call arguments at all (confirmed against
 * node-types.json — `argument_list`'s children are plain
 * `expression`/`compound_statement`/`initializer_list`/`preproc_defined`, no
 * "labeled argument" wrapper node type the way C#/Python have).
 *
 * -- a lambda bound to a variable ---------------------------------------------
 *
 * `auto log = [](const char* m) {...};` (including a capturing lambda,
 * `[&counter]() {...}` — confirmed a capture list doesn't change this
 * shape) is captured via `init_declarator declarator: (identifier) value:
 * (lambda_expression)`, mirroring every other language's "value bound to a
 * variable" pattern.
 */
export const CPP_TAGS_QUERY = `
; -- function / method definitions — see module doc comment for why
; @definition.function anchors on the OUTER function_definition, not the
; inner function_declarator this grammar's own tags.scm anchors on ----------

(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @definition.function

(function_definition
  declarator: (function_declarator
    declarator: (field_identifier) @name)) @definition.function

; an out-of-line method definition, e.g. \`int Calculator::outOfLine(...)\`.
; Does NOT scope-qualify (this function_definition is a top-level sibling of
; its class, not nested inside it) — see module doc comment.
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier name: (identifier) @name))) @definition.function

; a destructor, e.g. \`~Foo() {...}\`. Captures the WHOLE destructor_name node
; (giving the literal "~Foo" as the name) rather than diving into its inner
; identifier child — see module doc comment for the real constructor/
; destructor name collision this avoids.
(function_definition
  declarator: (function_declarator
    declarator: (destructor_name) @name)) @definition.function

; -- pointer/reference-returning functions — a real gap found by adversarial
; review, now fixed (see module doc comment): the SAME three name shapes
; above, each one layer deeper inside a pointer_declarator or
; reference_declarator wrapper. Destructors never return anything, so they
; have no pointer/reference-wrapped counterpart. -----------------------------

(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @name))) @definition.function

(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (field_identifier) @name))) @definition.function

(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (qualified_identifier name: (identifier) @name)))) @definition.function

; reference_declarator has no field name for its wrapped declarator
; (confirmed against node-types.json — unlike pointer_declarator), so these
; three are positional rather than using "declarator:".
(function_definition
  declarator: (reference_declarator
    (function_declarator
      declarator: (identifier) @name))) @definition.function

(function_definition
  declarator: (reference_declarator
    (function_declarator
      declarator: (field_identifier) @name))) @definition.function

(function_definition
  declarator: (reference_declarator
    (function_declarator
      declarator: (qualified_identifier name: (identifier) @name)))) @definition.function

; -- class / struct definitions (inline methods above qualify to
; Class.method for free via range containment; out-of-line ones do not —
; see module doc comment) ----------------------------------------------------

(class_specifier name: (type_identifier) @name) @definition.class

(struct_specifier name: (type_identifier) @name) @definition.class

; a lambda bound to a variable (local, with or without a capture list).
(init_declarator
  declarator: (identifier) @name
  value: (lambda_expression) @definition.function)

; -- calls ---------------------------------------------------------------------

; \`helper(x)\` — a bare call. Also matches user-defined-type functional-style
; construction (\`Point(1, 2)\`) — a verified, NOT excludable, Open Question
; (see module doc comment). Primitive-type casts (\`int(x)\`) do NOT match —
; this grammar gives them a different node type (primitive_type) in this
; exact position, confirmed against a real parse, no predicate needed.
(call_expression (identifier) @name) @reference.call

; \`obj.method()\` / \`this->method()\` — any receiver, either operator.
(call_expression
  (field_expression
    field: (field_identifier) @name)) @reference.call

; an explicit-template-argument free-function call, e.g. \`identity<int>(5)\`
; — a DIFFERENT node shape from the plain-identifier case above (see module
; doc comment); omitting this would silently miss every explicitly-
; instantiated template call.
(call_expression
  (template_function name: (identifier) @name)) @reference.call

; an explicit-template-argument method call, e.g. \`b.get<int>()\`.
(call_expression
  (field_expression
    field: (template_method name: (field_identifier) @name))) @reference.call

; a namespace-qualified or static/associated call, e.g. \`ns::helper(x)\`,
; \`Foo::staticMethod()\`, \`std::move(x)\` — a real gap found by adversarial
; review (see module doc comment); this DOES use the "function:" field,
; since call_expression's fields were wrongly claimed absent in this file's
; first draft (see module doc comment's correction).
(call_expression
  function: (qualified_identifier name: (identifier) @name)) @reference.call

; a function passed *by reference* as a direct (non-nested) call argument,
; e.g. \`registerHandler("/x", handlerFunc)\`. No named-argument guard needed
; — C++ has no labeled call arguments (see module doc comment).
(call_expression
  (argument_list (identifier) @reference.call.arg))
`;

/**
 * Rust tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333
 * R2c batch 2. Same capture-naming convention as javascript.ts/csharp.ts/
 * go.ts (`@definition.function`, `@definition.class`, `@name`,
 * `@reference.call`, `@reference.call.arg`). Node-type names below were read
 * from `tree-sitter-rust`'s `src/node-types.json` (0.23.1 — see
 * grammars.d.ts's doc comment for why this version is pinned) and verified
 * against real parses via `Parser.Query.matches`, not guessed.
 *
 * -- definitions --------------------------------------------------------------
 *
 * `function_item` (name: `identifier`, body: required `block`) covers free
 * functions and functions nested inside another function's body alike.
 * `function_signature_item` is the *distinct* node type for a body-less
 * function (a trait method declaration with no default implementation, e.g.
 * `fn area(&self) -> f64;` inside a `trait` block) — same "declare, don't
 * hand-massage" treatment as C#/Java's body-less interface methods: still a
 * nameable, qualifiable symbol, just never contributes a call site.
 *
 * A closure bound to a variable (`let log = |m: &str| {...};`, including a
 * `move` closure — `move` is a modifier keyword on `closure_expression`
 * itself, confirmed against a real parse not to change `let_declaration`'s
 * shape at all) mirrors the other languages' "value bound to a variable"
 * pattern via `let_declaration pattern: (identifier) value:
 * (closure_expression)`. Unlike Go's `short_var_declaration` (whose `left`/
 * `right` fields are *lists* that can hold multiple names, the source of
 * that file's adversarial-review-caught cross-pairing bug),
 * `let_declaration`'s `pattern` field is **singular**, not a list — a
 * multi-binding statement like `let (a, f) = (1, || {});` puts a
 * `tuple_pattern` in the `pattern` field, a different concrete node type than
 * `identifier`, so this pattern already can't cross-pair two names the way
 * Go's first draft did (confirmed by running the exact pattern against that
 * multi-binding shape: zero matches, not a wrong-named match — see
 * `test/rust.test.ts`). No anchor was needed to fix a bug here, unlike Go's
 * file; this was verified to already be safe by construction, not asserted.
 *
 * -- `impl`/`trait` blocks as `@definition.class` — verified DIFFERENT from
 * Go's struct+method situation, not copied from it -----------------------
 *
 * The task that produced this file explicitly asked not to copy Go's
 * struct+method conclusion mechanically. Verified against real parses that
 * Rust's situation is structurally **better** than Go's for scope-
 * qualification, not the same: a Go `method_declaration` is a top-level
 * *sibling* of its receiver type's `type_declaration` — never lexically
 * nested inside it — so Go's tag-query engine has nothing to qualify
 * against. Rust methods, by contrast, live inside an `impl_item`'s `body`
 * (`declaration_list`), and `impl_item` itself has its own well-defined byte
 * range that genuinely *contains* every method declared in that block — so
 * capturing `impl_item` as `@definition.class` (named from its `type:`
 * field, e.g. `Calculator` in `impl Calculator {...}`) gives the shared
 * `qualifyFunctions`/`findEnclosingFunction` range-containment logic
 * everything it needs *for free*, with no Rust-specific extractor.ts
 * post-processing step (unlike Go's documented Open Question, which
 * concluded a receiver-qualified id would need one). Verified end-to-end
 * (`test/rust.test.ts`): a method inside `impl Calculator {...}` qualifies to
 * `file#Calculator.compute`, not a bare `file#compute` the way Go's
 * unqualified methods do.
 *
 * Two `type:` field shapes were verified and both handled: a plain
 * `type_identifier` (`impl Calculator {...}`, also the Self type of a trait
 * impl like `impl std::fmt::Display for Calculator {...}` — the `type:`
 * field is always the *Self* type, never the trait name, confirmed against a
 * real parse of both an inherent and a trait impl each producing
 * `name=Calculator`) and a `generic_type` wrapping a `type_identifier`
 * (`impl<T> Container<T> {...}` → `name=Container`, confirmed against a real
 * parse). A `scoped_type_identifier` Self type (`impl other_mod::Foo {...}`)
 * is **not** handled by either pattern — a narrower, documented false
 * negative (the impl block itself, and hence scope-qualification for its
 * methods, is simply not captured; the methods are still extracted as
 * top-level-qualified Function nodes, same degraded-but-not-wrong outcome as
 * Go's every method) — left as an Open Question rather than a third pattern,
 * since it is a materially rarer shape than the two handled here. A
 * `reference_type` Self type (`impl Trait for &Foo {...}`, e.g. implementing
 * a trait for a reference to a type rather than the type itself — flagged
 * by adversarial review, then confirmed with a real parse: `impl Greet for
 * &Foo {...}` produces zero matches against both existing patterns) is a
 * third unhandled Self-type shape in the same category as
 * `scoped_type_identifier` above — left unhandled for the same reason (a
 * narrower shape than the two handled ones; the trait method inside still
 * extracts as a Function node, just without the `Foo.` qualification).
 *
 * `trait_item` (name: `type_identifier`, body: required `declaration_list`)
 * is captured the same way, for the same reason: it *does* lexically contain
 * both signature-only and default-implementation methods, so a trait's
 * default method also qualifies to `file#TraitName.method`.
 *
 * `struct_item`/`enum_item` are captured too (name: `type_identifier`,
 * low-cost bonus scope, same rationale as Go's struct/interface capture) —
 * but, like Go's struct capture, these do **not** help scope-qualify methods
 * (a struct/enum's own body never contains a method; methods live in a
 * separate, sibling `impl` block) — captured purely for graph completeness
 * (`egr top Class`, search) and because they never contribute a false CALLS
 * edge (`@definition.class` never enters the bare-name Function index used
 * for call resolution).
 *
 * A `mod` block (`mod foo { fn bar() {} }`, Rust's namespace/module
 * construct) is deliberately **not** captured as `@definition.class` —
 * unlike `impl`/`trait`, a module is not a *type*, and mislabeling it as a
 * "Class" node would be semantically wrong, not just imprecise (there is
 * nothing analogous to instantiate or scope a receiver against). A function
 * nested inside a `mod` block is still extracted as a Function node (the
 * `function_item` pattern doesn't care what its ancestor is) — it is simply
 * left unqualified by the module name, the same "no qualification, not a
 * wrong one" tradeoff as every other unhandled scope shape in this file.
 * Documented as an Open Question, not fixed.
 *
 * -- calls ---------------------------------------------------------------------
 *
 * Four call shapes, all via `call_expression function: (...)`, verified
 * against real parses: a bare identifier (`square(x)`); a field/method call
 * (`self.helper()`, `obj.method()`) via `field_expression field:
 * (field_identifier)` — the "value" (receiver) field is deliberately
 * unconstrained, same permissiveness as every other language's member-call
 * pattern; an **associated-function/scoped call**
 * (`Self::static_helper()`, `Type::function()`, `module::function()`) via
 * `scoped_identifier name: (identifier)` — a call shape none of the
 * JS/C#/Python/Go/Java files needed, since Rust's `::` path syntax for
 * calling a type-associated or module-qualified function has no equivalent
 * in those languages' grammars; and an **explicit-turbofish generic call**
 * (`parse::<i32>(s)`, `f.collect_it::<i32>()`, `std::mem::size_of::<i32>()`)
 * — a **real gap missed in this file's first draft**, found by adversarial
 * review, not by the original development pass: `call_expression`'s
 * `function:` field becomes a `generic_function` node wrapping — not
 * replacing — the actual callee (an `identifier`, `field_expression`, or
 * `scoped_identifier`, confirmed against real parses of all three), a
 * *different* shape from the plain cases above that the original three
 * patterns silently did not match at all (confirmed: zero captures for
 * `parse_it::<i32>("5")` before this fix, while its argument `"5"`... no,
 * the *literal* argument isn't a by-reference risk, but a bare-identifier
 * argument to a missed turbofish call would still be captured as a
 * by-reference-arg candidate even though the call itself was invisible —
 * the same asymmetry C++'s module doc comment warns about for its own
 * `template_function`/`template_method` patterns, which this file's first
 * draft did not carry over despite C++'s file explicitly calling out "omitting
 * these two would silently miss every explicitly-instantiated template
 * call"). Three sub-patterns, mirroring the three plain-call shapes above.
 *
 * -- Rust-specific false-positive risk found during this file's development,
 * not named in the original task (the same underlying limitation as Go's
 * type-conversion ambiguity and Python's class-instantiation ambiguity —
 * see queries/go.ts's and queries/python.ts's module docs for the full
 * writeup of this shared limitation) — **tuple-struct and enum-variant
 * construction is grammatically identical to a call** ------------------------
 *
 * `Point(1, 2)` (constructing a tuple struct `struct Point(i32, i32);`) and
 * `Some(5)` (constructing the `Option` enum variant) both parse to the exact
 * same shape as a real call — `call_expression function: (identifier)
 * arguments: (arguments (...))` — confirmed against a real parse comparing
 * both against an ordinary `Helper(x)` call: Rust's grammar has no distinct
 * "tuple-struct construction" or "enum-variant construction" node type, so
 * this pattern captures `Point`/`Some` as a callee name exactly like a real
 * function call. As with Python/Go, the practical risk is narrow:
 * `@definition.class` captures (`struct_item`/`enum_item`/`impl_item`/
 * `trait_item`) never enter the bare-name `Function` index CALLS resolution
 * reads from, so `Point(1, 2)` only resolves to something at all if a real
 * *function* (not the struct/variant itself) happens to share the exact name
 * `Point` elsewhere in the indexed corpus. Grouped with Go's/Python's Open
 * Question as one shared limitation (a bare-identifier call-shaped construct
 * that isn't really invoking a function, in a language whose grammar can't
 * tell the difference without semantic/type information), not a Rust-only
 * quirk.
 *
 * -- Rust-specific false-positive risk explicitly named in the task: macro
 * invocations (`println!(...)`, `vec![...]`, `write!(...)`) --------------
 *
 * A macro invocation (`macro_name!(...)`/`macro_name![...]`/
 * `macro_name!{...}`) is `macro_invocation` — a **distinct node type** from
 * `call_expression` (confirmed against node-types.json and a real parse of
 * `println!("{}", m)` sitting next to a real call in the same function body:
 * only the real call matched `@reference.call`, `println!` did not match
 * at all, not even partially). Because none of this file's `@reference.call`
 * patterns target `macro_invocation`, macro invocations are excluded by
 * construction — not a guard that had to be added, a structural consequence
 * of the grammar giving macros their own node type (verified, not assumed:
 * ordinary function calls and macro invocations cannot collide the way
 * Go's/Python's/C++'s "type-name-as-call" ambiguities do, because a Rust
 * macro name and a function name are already syntactically distinguished by
 * the trailing `!` at the *grammar* level, before this file's queries even
 * run).
 *
 * -- by-reference call arguments (the Rust analogue of the JS Fastify
 * `app.register(pluginFn, opts)` pattern) — e.g. `thread::spawn(my_function)`,
 * `http::HandleFunc("/x", handler_fn)` -----------------------------------
 *
 * A bare identifier that is a direct (non-nested) child of `arguments`
 * counts, same "positional and non-nested only" cut as every other
 * language. No named-argument-style guard is needed: Rust, like Go, has no
 * named/keyword call arguments at all (confirmed against node-types.json —
 * `arguments`'s children are plain `_expression`/`attribute_item`, no
 * "labeled argument" wrapper node type the way C#/Python have).
 */
export const RUST_TAGS_QUERY = `
; -- function / trait-method-signature definitions --------------------------

(function_item name: (identifier) @name) @definition.function

(function_signature_item name: (identifier) @name) @definition.function

; a closure bound to a variable: \`let log = |m: &str| {...};\` (also matches
; a "move" closure — see module doc comment). let_declaration's "pattern"
; field is singular, unlike Go's short_var_declaration — no cross-pairing
; risk, verified against a real multi-binding-shape parse (see test file).
(let_declaration
  pattern: (identifier) @name
  value: (closure_expression) @definition.function)

; -- impl / trait blocks as scope-qualifying "classes" (see module doc
; comment for why this is verified DIFFERENT from Go's struct+method case,
; not copied from it: unlike Go, these DO lexically contain their methods,
; so scope-qualification works here with no extractor.ts changes) ------------

(impl_item type: (type_identifier) @name) @definition.class

(impl_item type: (generic_type type: (type_identifier) @name)) @definition.class

(trait_item name: (type_identifier) @name) @definition.class

; -- struct / enum type definitions (low-cost bonus scope; do NOT help
; scope-qualify methods — see module doc comment, same caveat as Go's
; struct/interface capture) --------------------------------------------------

(struct_item name: (type_identifier) @name) @definition.class

(enum_item name: (type_identifier) @name) @definition.class

; -- calls ---------------------------------------------------------------------

; \`square(x)\` — a bare call. Tuple-struct/enum-variant construction
; (\`Point(1, 2)\`, \`Some(5)\`) is grammatically identical and NOT excluded
; here — see module doc comment's Open Question (same shared limitation as
; Go's type-conversion / Python's class-instantiation ambiguity).
(call_expression function: (identifier) @name) @reference.call

; \`self.helper()\` / \`obj.method()\` — any receiver.
(call_expression
  function: (field_expression
    field: (field_identifier) @name)) @reference.call

; \`Self::static_helper()\` / \`Type::function()\` / \`module::function()\` — an
; associated-function or module-qualified call via Rust's "::" path syntax,
; a shape none of this engine's other languages need.
(call_expression
  function: (scoped_identifier
    name: (identifier) @name)) @reference.call

; explicit-turbofish generic calls (\`parse::<i32>(s)\`,
; \`f.collect_it::<i32>()\`, \`std::mem::size_of::<i32>()\`) — a gap found by
; adversarial review (see module doc comment): \`generic_function\` wraps,
; rather than replaces, each of the three plain-call callee shapes above.
(call_expression
  function: (generic_function
    function: (identifier) @name)) @reference.call

(call_expression
  function: (generic_function
    function: (field_expression
      field: (field_identifier) @name))) @reference.call

(call_expression
  function: (generic_function
    function: (scoped_identifier
      name: (identifier) @name))) @reference.call

; a function passed *by reference* as a direct (non-nested) call argument,
; e.g. \`thread::spawn(my_function)\`. No named-argument guard needed — Rust
; has no labeled call arguments (see module doc comment). Macro invocations
; (\`println!(...)\`) are a distinct node type (macro_invocation) and never
; reach this pattern at all (see module doc comment) — not a guard, a
; structural non-issue.
(call_expression
  arguments: (arguments (identifier) @reference.call.arg))
`;

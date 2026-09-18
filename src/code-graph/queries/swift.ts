/**
 * Swift tag query (tree-sitter Query API, S-expression syntax) — XSPEC-414
 * R3. Same capture-naming convention as every other language on this engine
 * (`@definition.function`, `@definition.class`, `@name`, `@reference.call`,
 * `@reference.call.arg`). Node-type names below were read from
 * `tree-sitter-swift`'s `src/node-types.json` (0.7.1 — see
 * `language-support.js`'s doc comment for why this version is pinned) and
 * verified against real parses via `Parser.Query.matches`, not guessed.
 *
 * -- class / struct / enum / protocol / EXTENSION all share ONE node type,
 * verified rather than assumed — this is the mechanism that makes extension
 * attribution work for free --------------------------------------------------
 *
 * `class`, `struct`, `enum`, `actor` AND `extension` declarations all parse
 * to the SAME node type, `class_declaration`, distinguished only by an
 * anonymous `declaration_kind` field token this file's pattern below never
 * needs to inspect (confirmed against `node-types.json`: `declaration_kind`
 * accepts `"actor"`/`"class"`/`"enum"`/`"extension"`/`"struct"` as sibling
 * literal values on the exact same node type). `protocol` gets its own
 * distinct node type, `protocol_declaration`, captured separately below with
 * an identical shape.
 *
 * `class_declaration`'s `name:` field is `required: true` but its declared
 * type varies with context — verified against real parses that a plain
 * declaration (`struct Foo {...}`) gives a bare `type_identifier`, while an
 * `extension Foo {...}` gives a `user_type` node WRAPPING a `type_identifier`
 * one level deeper. Both are matched by ONE wildcard pattern, `name: (_)
 * @name`, rather than enumerating every possible wrapper: `SyntaxNode.text`
 * returns the node's full source span regardless of how deeply it is
 * nested, so `(_)` at the `name:` position captures "Foo" correctly either
 * way (confirmed empirically for both shapes, not assumed from the wrapper
 * difference being "probably harmless").
 *
 * **This one mechanism is also this file's extension-attribution answer**
 * (XSPEC-414 R3's core requirement): capturing `extension Foo {...}` as
 * `@definition.class` named "Foo" — the type being extended, not any name of
 * the extension itself (Swift extensions are anonymous) — gives the shared
 * `qualifyFunctions` range-containment logic everything it needs for free,
 * the same "bonus scope container" trick `queries/rust.ts`'s `impl` blocks
 * and `queries/kotlin.ts`'s `object_declaration` already use. A method
 * defined inside `extension Foo {...}` in `Foo+Ext.swift` therefore
 * qualifies to `Foo+Ext.swift#Foo.methodName` — attributed to "Foo", exactly
 * as R3 requires — verified end-to-end in `test/swift.test.ts`.
 *
 * **Known, documented limitation, same shape as every other language's
 * cross-file type-identity gap here (Go's unqualified receiver methods,
 * C++'s out-of-line methods)**: because a `Class` node's id is
 * `${filePath}#class:${name}` (file-scoped, per `extractor.ts`'s
 * `collectExtraction`), `struct Foo` in `Foo.swift` and `extension Foo` in
 * `Foo+Ext.swift` produce TWO separate `Class` nodes both named "Foo",
 * rather than one merged type-level node — this engine has no cross-file
 * type-identity merge for ANY language, not a new Swift-only gap. It does
 * not affect CALLS resolution, which keys off the bare FUNCTION name via a
 * project-wide index, not off which Class node a method's qualifier
 * happens to point at (confirmed in `test/swift.test.ts`: a cross-file call
 * into an extension method resolves correctly despite this).
 *
 * -- function definitions -----------------------------------------------
 *
 * `function_declaration`'s `name:` field is declared `multiple: true` in
 * this grammar (it doubles as the slot for an operator-overload symbol) —
 * verified against a real parse that a function WITH a return type
 * (`-> Int`) actually produces TWO `name:`-field children: the real
 * `simple_identifier` name, and — confusingly reusing the same field label —
 * the return type's OWN node (`user_type`/etc). Anchoring this file's
 * pattern on `name: (simple_identifier) @name` rather than a bare `name: (_)
 * @name` is deliberate, not stylistic: a return-type node is never a
 * `simple_identifier` (confirmed against several return-type shapes), so
 * this pattern only ever matches the real function name, never the return
 * type — verified by checking the actual capture text against a
 * return-typed function before trusting this.
 *
 * `init_declaration` (a Swift initializer/constructor) has NO `name:` field
 * at all — `init` is a keyword, not an identifier this grammar exposes as a
 * named child (confirmed against node-types.json: the field list is
 * `body`/`default_value`, no `name`). Its own anonymous `"init"` token IS
 * queryable as a literal string pattern, though — tree-sitter's Query DSL
 * matches anonymous/unnamed terminal tokens written as a bare string literal
 * (confirmed empirically: `(init_declaration "init" @name)` captures the
 * text `"init"`), giving every constructor the synthetic name `init` the
 * same way C#/Java's constructors reuse their class's name — qualifying to
 * e.g. `file#Foo.init`, a real, if generic, function id every initializer
 * shares (same documented "two overloads collapse onto one id" limitation
 * this engine already has for C#/Go, not a new Swift-only quirk: two
 * `init` overloads in one type collide onto `Foo.init`).
 *
 * A protocol's or a body-less requirement's method declaration
 * (`func greet() -> String` with no body, inside a `protocol {...}`) is a
 * DIFFERENT, distinct node type, `protocol_function_declaration` — verified
 * against a real parse — not `function_declaration`. Deliberately NOT
 * captured as a `@definition.function` here: it never has a body to search
 * for call sites in, and it names an obligation, not a callable definition
 * with its own identity worth graphing — the same "declare, don't
 * hand-massage a signature with no body" cut C#/Java's interface methods
 * and Rust's `function_signature_item` already make in this engine (see
 * `queries/rust.ts`'s module doc comment).
 *
 * -- calls -----------------------------------------------------------------
 *
 * `call_expression` has NO named fields in this grammar (confirmed against
 * node-types.json: `fields: {}`) — the callee is always its first
 * positional child, verified against real parses for three shapes:
 *
 *  - `(simple_identifier)` directly under `call_expression` — a bare call
 *    (`helper(x)`), including calling a type's initializer with construction
 *    syntax (`Dog()`) — the same construction-vs-call ambiguity every other
 *    language here documents (Go's type conversions, C++/Rust's
 *    tuple/functional-style construction — see those files' module docs),
 *    not specially excluded here either.
 *  - `(navigation_expression suffix: (navigation_suffix suffix:
 *    (simple_identifier)))` — `obj.method()` (any receiver — verified this
 *    also fires for `self.method()`, since `self_expression` is simply
 *    whatever sits in `navigation_expression`'s unconstrained `target:`
 *    position, not part of this pattern's own match).
 *
 * A function passed *by reference* as a direct (non-nested) call argument
 * (e.g. `registerHandler("/x", onRequest)`) uses `value_argument`'s
 * `value:` field — verified DISTINCT from the argument LABEL, which lives
 * in a separate, optional `name:` field of its own type
 * (`value_argument_label`, confirmed against node-types.json and a real
 * parse of `foo(handler: bar)`): this pattern only ever reads `value:`,
 * so a labeled call (`foo(handler: bar)`) still correctly captures `bar`
 * as the by-reference argument, with no risk of the label `handler` itself
 * being mistaken for one (unlike C#/Python's named-argument guard, no
 * `!name` exclusion is needed here — the label and the value are two
 * different fields, not one field two different callers could fill).
 *
 * **Grammar quirk found while verifying against real parses, not a bug in
 * this file's patterns**: `tree-sitter-swift@0.7.1` resolves
 * `helper(rate) + self.base()` (a binary `+` immediately followed by a
 * member call) as `(helper(rate) + self).base()` — the member-call suffix
 * binds to the WHOLE additive expression, not just `self`, which is not how
 * Swift itself evaluates this (member access should bind tighter than
 * `+`). Harmless for this file's purposes: the outer, mis-nested
 * `call_expression`'s navigation suffix is still `base`, so `@name` still
 * captures the right callee — the CALLS edge this produces (`addTax` calls
 * `base`) is still correct, just reached through a stranger parse-tree
 * shape than the source reads. Not chased further (a parser precedence fix
 * is upstream's to make); noted here so a future reader who dumps this
 * exact shape does not mistake it for this file's own defect.
 * `test/swift.test.ts`'s fixtures avoid this exact adjacent-binary-operator
 * shape to keep its assertions about DIFFERENT things (extension
 * attribution, cross-file resolution) legible.
 */
export const SWIFT_TAGS_QUERY = `
; -- class / struct / enum / actor / extension — one shared node type,
; disambiguated only by an anonymous keyword this file never inspects. The
; wildcard name capture handles both the plain (type_identifier) and the
; extension's (user_type (type_identifier)) wrapper shape — see module doc
; comment. --------------------------------------------------------------

(class_declaration name: (_) @name) @definition.class

(protocol_declaration name: (_) @name) @definition.class

; -- function definitions ----------------------------------------------------

(function_declaration name: (simple_identifier) @name) @definition.function

; an initializer/constructor — no name field exists (see module doc
; comment); the literal "init" token itself is captured, giving every
; constructor the synthetic name "init".
(init_declaration "init" @name) @definition.function

; -- calls ---------------------------------------------------------------------

; \`helper(x)\` — a bare call, also matches initializer/construction syntax
; (\`Dog()\`) — see module doc comment, same ambiguity as every other
; language here.
(call_expression (simple_identifier) @name) @reference.call

; \`obj.method()\` / \`self.method()\` — any receiver.
(call_expression
  (navigation_expression
    suffix: (navigation_suffix
      suffix: (simple_identifier) @name))) @reference.call

; a function passed *by reference* as a direct (non-nested) call argument,
; e.g. \`registerHandler("/x", onRequest)\`. Reads ONLY the "value:" field —
; a labeled argument's label lives in a separate "name:" field this pattern
; never touches (see module doc comment), so no named-argument guard is
; needed.
(value_argument value: (simple_identifier) @reference.call.arg)
`;

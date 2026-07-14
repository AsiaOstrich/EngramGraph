/**
 * Python tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333
 * R2c, the first *dynamic* language on the generic tag-query engine
 * (tag-query-engine.ts) — JS/TS/C# are all statically-scoped, brace-block
 * languages; Python's indentation-based grammar and lack of a distinct
 * "method" node type are the first real test of whether the engine
 * generalizes beyond that family. Same capture-naming convention as
 * javascript.ts/csharp.ts (`@definition.function`, `@definition.class`,
 * `@name`, `@reference.call`, `@reference.call.arg`). Node-type names below
 * were read from `tree-sitter-python`'s `src/node-types.json` (0.23.4 — see
 * grammars.d.ts's doc comment for why this version is pinned) and verified
 * against real parses via `Parser.Query.matches`, not guessed.
 *
 * -- definitions --------------------------------------------------------------
 *
 * Python has **no separate node type for a class method** — `class_definition`
 * `body` is a `block` that directly contains `function_definition` nodes (a
 * method is syntactically just a function defined inside a class body).
 * This means a single `function_definition` pattern below covers module-level
 * functions, class methods and nested functions alike; the tag-query engine's
 * range-containment `qualifyFunctions` post-processing (not this file) is
 * what turns "a function_definition physically inside a class_definition's
 * range" into the qualified id `file#ClassName.method_name` — no
 * Python-specific scope logic needed here, unlike C#'s split
 * `method_declaration`/`constructor_declaration`/`local_function_statement`.
 *
 * `@staticmethod`/`@classmethod`/any other decorator wraps the
 * `function_definition` in a `decorated_definition`, but the inner
 * `function_definition` node itself is untouched (confirmed against a real
 * parse) — this pattern still matches it directly, decorator or not.
 *
 * `class_definition`'s `body` field is always required (no body-less class
 * declarations, unlike C#'s body-less `record`) — no special-casing needed.
 *
 * A lambda bound to a variable (`log = lambda m: print(m)`) mirrors the
 * JS/C# "value bound to a variable declarator" pattern. Python's assignment
 * target field is `left` (abstract type `pattern`, of which `identifier` is
 * one concrete subtype — per node-types.json), and the value is `right`.
 * Only a bare `identifier` target is matched (not `pattern_list`/tuple
 * unpacking) — same "don't chase destructuring" precision cut as JS/C#'s own
 * variable-binding patterns.
 *
 * -- calls ----------------------------------------------------------------
 *
 * `call function: (identifier)` is a bare call (`helper()`); `call function:
 * (attribute attribute: (identifier))` is `obj.method()` / `self.method()` —
 * `attribute`'s "object" (receiver) field is deliberately unconstrained, same
 * permissiveness as JS/C#'s member-call patterns. Note the field name is
 * `attribute` (not `name`/`property`) — this grammar's own naming, read from
 * node-types.json rather than assumed from the JS/C# convention.
 *
 * -- by-reference call arguments (the Python analogue of the JS Fastify
 * `app.register(pluginFn, opts)` / C# "method group" pattern) --------------
 *
 * A bare identifier that is a *direct* child of `argument_list` (Python's
 * equivalent of JS's `arguments`/C#'s `argument_list`) counts, same
 * "positional and non-nested only" precision cut as the other languages —
 * e.g. `signal.signal(signal.SIGINT, handler_fn)`.
 *
 * The Python-specific false-positive risk this file's first draft checked
 * for — analogous to C#'s named-argument-label / `nameof(X)` lessons — is
 * **keyword arguments**: `foo(handler=some_handler)`. Verified against a
 * real parse that this grammar wraps a keyword argument in its own distinct
 * node type, `keyword_argument` (fields `name`/`value`, both `identifier`s
 * here), which is itself the direct child of `argument_list` — the bare
 * identifier holding the *value* (`some_handler`) is therefore a
 * *grandchild* of `argument_list`, not a direct child. This was then
 * double-checked by running an actual `Parser.Query` for
 * `(argument_list (identifier) @arg)` against `foo(handler=some_handler)`:
 * it captures only true positional bare-identifier arguments and does *not*
 * capture `some_handler` — confirmed empirically against the real Query
 * engine, not just inferred from the parse tree shape. Unlike C#, no
 * `!name`-style predicate is needed here: Python's grammar structurally
 * separates positional and keyword arguments into different node types at
 * the `argument_list` level, so the plain "(argument_list (identifier))"
 * pattern already excludes keyword arguments for free. One consequence,
 * matching this file's general precision-over-recall stance: a function
 * passed *by keyword* (`Thread(target=run)`, `sorted(items, key=compare)` —
 * both common idioms) is a documented false-negative, not captured — same
 * tradeoff C#'s `!name` guard makes explicitly, just structural here instead
 * of predicate-driven.
 *
 * Two further Python constructs were checked and found *not* to interfere
 * with this pattern (both confirmed against real parses): `*args`/`**kwargs`
 * unpacking (`foo(*handlers)`) wraps the identifier in `list_splat`/
 * `dictionary_splat`, again a grandchild not a direct child; and a
 * decorator's own call (`@app.route('/x')`) sits as a *sibling* of the
 * function_definition it decorates (inside `decorated_definition`), outside
 * that function's own byte range, so — same as JS/C#'s "call outside any
 * function is dropped" rule — a call inside a decorator is not attributed to
 * the function it decorates unless the decorator itself is written inside
 * some other enclosing function. When it *is* (a decorator factory called
 * from inside another function), attributing the decorator's call to that
 * *outer* enclosing function is actually semantically correct, not a quirk
 * to work around — the decorator expression genuinely executes as part of
 * that outer function's execution, the same moment the `def` statement
 * itself runs.
 *
 * -- found during this file's development, not named in the original task
 * (analogous to Go's exactly-parallel type-conversion ambiguity — see
 * queries/go.ts's module doc comment for the full writeup of the same
 * underlying limitation) — **class instantiation is grammatically identical
 * to a call** ----------------------------------------------------------------
 *
 * `Foo()` (instantiating class `Foo`) parses to the exact same shape as a
 * real call — `call function: (identifier) arguments: (argument_list)` —
 * confirmed against a real parse; Python's grammar has no distinct
 * "constructor call" node type, so this pattern captures `Foo` as a callee
 * name exactly like a real function call. In practice this rarely produces
 * a *wrong* CALLS edge: `@definition.class` captures never enter the
 * bare-name `Function` index that CALLS resolution reads from (only
 * `@definition.function` captures do), so `Foo()` only resolves to
 * something at all if a real *function* (not the class itself) happens to
 * share the exact name `Foo` elsewhere in the indexed corpus — narrowed
 * further in practice by PEP 8's convention of `CapWords` for classes vs.
 * `snake_case` for functions, though that convention is not enforced by the
 * grammar and this analysis has no way to check it. This is the same
 * underlying limitation as Go's user-defined type-conversion ambiguity (both
 * are "a bare-identifier call-shaped construct that isn't really invoking a
 * function, in a language whose grammar can't tell the difference without
 * semantic/symbol information") — treated here as one documented Open
 * Question shared across both languages, not two separately-discovered
 * quirks, so a future reader doesn't mistake this for a Python-only gap.
 *
 * -- a documented consequence of `collectComments` being a plain
 * `comment`-node walk (see tag-query-engine.ts), not anything specific to
 * this file --------------------------------------------------------------
 *
 * Python's docstring convention (`"""..."""` as the first statement of a
 * function/class/module) is a plain `string` node, not a `comment` node —
 * confirmed against node-types.json (Python has no docstring-specific node
 * type; it is purely a convention about *where* a string literal appears).
 * A `// implements XSPEC-NNN`-equivalent written inside a docstring is
 * therefore not picked up by `collectComments` — this is expected, not a
 * gap this file's queries could fix (the convention is, and always was,
 * "written in a comment", and a Python docstring is not a comment node by
 * this grammar's own type system) — worth stating explicitly so it is not
 * mistaken for a silent failure the way the Java `line_comment`/
 * `block_comment` split (see tag-query-engine.ts's `collectComments` doc
 * comment) legitimately was.
 */
export const PYTHON_TAGS_QUERY = `
; -- class definitions --------------------------------------------------------

(class_definition name: (identifier) @name) @definition.class

; -- function definitions ----------------------------------------------------

; covers module-level functions, class methods (no distinct method node type
; in this grammar) and nested functions alike — scope-qualification is
; reconstructed from byte-range containment by the shared engine, not here.
(function_definition name: (identifier) @name) @definition.function

; a lambda bound to a variable: \`log = lambda m: print(m)\`.
(assignment
  left: (identifier) @name
  right: (lambda) @definition.function)

; -- calls ---------------------------------------------------------------------

; \`helper(...)\`
(call function: (identifier) @name) @reference.call

; \`obj.method(...)\` / \`self.method(...)\` — any receiver.
(call
  function: (attribute
    attribute: (identifier) @name)) @reference.call

; a function passed *by reference* as a direct positional call argument, e.g.
; \`signal.signal(signal.SIGINT, handler_fn)\`. Keyword arguments
; (\`foo(handler=x)\`) are structurally excluded already — see module doc
; comment — no \`!name\`-style predicate needed, unlike C#.
(call
  arguments: (argument_list (identifier) @reference.call.arg))
`;

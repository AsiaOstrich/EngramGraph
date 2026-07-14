/**
 * JavaScript tag query (tree-sitter Query API, S-expression syntax).
 *
 * Declares — instead of hand-coding a recursive node-type walker — what
 * counts as a function/class definition and a call in the JS grammar. This
 * is the same idea as Aider's `tags.scm` or GitHub Code Navigation's tag
 * queries: capture names (`@definition.function`, `@definition.class`,
 * `@name`, `@reference.call`) follow that convention so this file reads the
 * same way a `tags.scm` for another language would (XSPEC-333 R2).
 *
 * Every pattern here exists because the pre-refactor hand-written walker
 * (see extractor.ts git history before this commit) checked that exact
 * node-type / field combination — this is a behavior-preserving port, not a
 * new design. See `tag-query-engine.ts` for the range-containment
 * post-processing that reconstructs nested scopes from these flat captures.
 */
export const JAVASCRIPT_TAGS_QUERY = `
; -- function definitions ----------------------------------------------------

(function_declaration name: (identifier) @name) @definition.function

(generator_function_declaration name: (identifier) @name) @definition.function

; class method (incl. nested inside a class body). The name field's node
; type varies with method-name syntax — property_identifier (normal),
; computed_property_name (\`[x](){}\`), private_property_identifier
; (\`#x(){}\`), string (\`"x"(){}\`), number (\`1(){}\`) — the old walker took
; the raw \`.text\` of whatever the name field held with no type check, so
; the wildcard "(_)" (any named node) reproduces that exactly rather than
; silently dropping the non-property_identifier cases.
(method_definition name: (_) @name) @definition.function

; arrow / function expression bound to a variable: \`const log = (m) => ...\`.
; Anchoring on "value:" of a variable_declarator reproduces the old walker's
; "node.parent?.type === variable_declarator" gate — an anonymous function
; expression passed as a bare callback argument (parent = arguments, not
; variable_declarator) is deliberately NOT a definition, same as before.
; "(_)" (not "(identifier)") on the name field: the old walker took the raw
; \`.text\` of whatever the variable_declarator's name field held with no
; type check, so a function value destructure-bound to a non-identifier
; pattern (e.g. the degenerate \`const {f} = () => 1\` — syntactically legal,
; never written in real code) still got a garbage-but-real \`Function\` node
; (name "{f}") in the old code; the wildcard reproduces that rather than
; silently dropping it.
;
; NOTE: the old FUNCTION_VALUE_TYPES set also listed a "function" node type
; that does not exist in the bundled tree-sitter-javascript grammar (a query
; referencing an unknown node type fails to compile) — it was already dead
; against these grammar versions, so omitting it here changes nothing
; observable.
(variable_declarator
  name: (_) @name
  value: [(arrow_function) (function_expression)] @definition.function)

; -- class definitions --------------------------------------------------------

(class_declaration name: (identifier) @name) @definition.class

(class name: (identifier) @name) @definition.class

; -- calls ---------------------------------------------------------------------

; \`fn(...)\`
(call_expression function: (identifier) @name) @reference.call

; \`obj.method(...)\` / \`this.method(...)\` / \`this.#method(...)\` — callee =
; property name. member_expression's "property" field is only ever
; property_identifier or private_property_identifier (grammar's
; node-types.json), so this alternation — not a single node type — is what
; reproduces the old walker's untyped \`.text\` extraction exactly; a
; property_identifier-only pattern would silently drop every private-method
; call (\`this.#priv()\`).
(call_expression
  function: (member_expression
    property: [(property_identifier) (private_property_identifier)] @name)) @reference.call

; a function passed *by reference* as a direct (non-nested) call argument,
; e.g. Fastify's \`app.register(pluginFn, opts)\` (DEC-095) — only a bare
; identifier directly under "arguments" counts; one nested inside an
; object/array literal argument is a materially weaker signal and is
; intentionally not captured (see extractor.ts module doc comment).
(call_expression
  arguments: (arguments (identifier) @reference.call.arg))
`;

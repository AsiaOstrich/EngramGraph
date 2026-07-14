/**
 * TypeScript / TSX tag query (tree-sitter Query API, S-expression syntax).
 *
 * Identical in shape to `javascript.ts` (see that file's doc comment for the
 * rationale and capture-naming convention) — the only grammar difference
 * that matters for these patterns is that a class's `name` field is a
 * `type_identifier` node in the TypeScript/TSX grammars, vs. a plain
 * `identifier` in JavaScript's. Everything else (function_declaration,
 * generator_function_declaration, method_definition, variable_declarator,
 * call_expression) uses the same node-type names across all three bundled
 * grammars, so one query covers both the "typescript" and "tsx"
 * `SupportedLanguage` variants (the tsx grammar only adds JSX-specific node
 * types, which these patterns never reference).
 */
export const TYPESCRIPT_TAGS_QUERY = `
; -- function definitions ----------------------------------------------------

(function_declaration name: (identifier) @name) @definition.function

(generator_function_declaration name: (identifier) @name) @definition.function

; name field's node type varies with method-name syntax (see javascript.ts's
; comment on this same pattern for the full rationale) — wildcard "(_)"
; reproduces the old walker's untyped \`.text\` extraction exactly.
(method_definition name: (_) @name) @definition.function

; "(_)" on the name field (see javascript.ts's comment on this same pattern):
; reproduces the old walker's untyped \`.text\` extraction for the degenerate
; destructure-bound case too, not just the common plain-identifier one.
(variable_declarator
  name: (_) @name
  value: [(arrow_function) (function_expression)] @definition.function)

; -- class definitions --------------------------------------------------------
; NOTE: name field is type_identifier here (identifier in javascript.ts).
; abstract_class_declaration is intentionally NOT matched — the old
; CLASS_TYPES set never included it either, so abstract classes were (and
; still are) not captured as Class nodes.

(class_declaration name: (type_identifier) @name) @definition.class

(class name: (type_identifier) @name) @definition.class

; -- calls ---------------------------------------------------------------------

(call_expression function: (identifier) @name) @reference.call

; member_expression's "property" field is only ever property_identifier or
; private_property_identifier (see javascript.ts's comment on this pattern
; for the full rationale — a private-method call like \`this.#priv()\` needs
; the alternation, not just property_identifier).
(call_expression
  function: (member_expression
    property: [(property_identifier) (private_property_identifier)] @name)) @reference.call

(call_expression
  arguments: (arguments (identifier) @reference.call.arg))
`;

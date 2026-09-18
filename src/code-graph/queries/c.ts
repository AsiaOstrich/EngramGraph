/**
 * C tag query (tree-sitter Query API, S-expression syntax) — XSPEC-414 R2.
 * Same capture-naming convention as every other language on this engine
 * (`@definition.function`, `@definition.class`, `@name`, `@reference.call`,
 * `@reference.call.arg`), plus one new capture this batch introduces,
 * `@reference.import`, for `#include` (see the "module relationships"
 * section below). Node-type names below were read from `tree-sitter-c`'s
 * `src/node-types.json` (0.23.6 — see `language-support.js`'s doc comment
 * for why this exact version is pinned) and verified against real parses
 * via `Parser.Query.matches`, not guessed.
 *
 * This file's shapes are a strict SUBSET of `queries/cpp.ts`'s (both
 * grammars model `function_definition`/`function_declarator` almost
 * identically — expected, since `tree-sitter-c` and `tree-sitter-cpp` are
 * sibling grammars from the same project) — C has no classes, no
 * destructors, no namespaces/`qualified_identifier`, no templates and no
 * references (`reference_declarator` does not exist in this grammar's
 * `node-types.json`, confirmed by lookup), so those patterns are simply
 * absent here rather than adapted.
 *
 * -- function definitions — the same OUTER/`function_declarator` split as
 * C++, with the same pointer-return wrapper, verified independently here
 * rather than assumed to carry over -----------------------------------------
 *
 * `function_definition`'s only relevant field is `declarator:`, a
 * `function_declarator` whose OWN `declarator:` field holds the actual name
 * — confirmed via node-types.json and a real parse (`int add(int a, int b)
 * {...}` → `function_definition declarator: (function_declarator
 * declarator: (identifier))`). `@definition.function` anchors on the OUTER
 * `function_definition` (spans the full body), not the inner
 * `function_declarator` (spans only the name + parameter list) — same
 * reasoning as `queries/cpp.ts`'s module doc comment: anchoring on the
 * inner node would break this engine's range-containment call attribution
 * for every function with a non-trivial body.
 *
 * A pointer-returning function (`int* makePtr(int x) {...}`) wraps the
 * `function_declarator` in one more `pointer_declarator` layer — verified
 * against a real parse (`declarator: (pointer_declarator declarator:
 * (function_declarator declarator: (identifier)))`), same shape as C++'s
 * pointer case. C has no references, so there is no `reference_declarator`
 * counterpart to add. A double-pointer return (`char **argv_copy(...)`)
 * nests `pointer_declarator` twice and is NOT covered by either pattern
 * below (same scope cut C++'s file made for its own pointer case — see
 * that file's module doc comment) — left as a documented, not-yet-hit
 * Open Question rather than chased with a third nesting level up front.
 *
 * -- struct / union / enum -----------------------------------------------
 *
 * `struct_specifier`/`union_specifier`/`enum_specifier` (all with an
 * optional `name:` field of `type_identifier` — optional because a forward
 * declaration or an anonymous struct field has none, confirmed via
 * node-types.json) are captured as `@definition.class`, matching how every
 * other language on this engine uses `Class` nodes for "a named type", not
 * only for OOP classes (see queries/rust.ts's struct/enum treatment). C has
 * no methods defined inside these bodies at all — unlike C++'s inline
 * methods, a struct/union/enum capture here never contains a
 * `@definition.function`, so this gives `qualifyFunctions`' range-
 * containment logic nothing to nest (verified: no C construct puts a
 * `function_definition` lexically inside a `struct_specifier`'s body).
 * `typedef struct Point Point;`'s bodyless `struct_specifier` also matches
 * (same name, no body) — a second, harmless capture of the same class id as
 * the full definition (idempotent `MERGE` in `writer.ts`), the same
 * duplicate-forward-declaration non-issue C++ already has for `class Foo;`.
 *
 * -- calls -----------------------------------------------------------------
 *
 * `call_expression` has real `function:`/`arguments:` fields in this
 * grammar (confirmed via node-types.json, same as C++'s — see cpp.ts's
 * module doc comment for the correction that established this for the C
 * family). Two callee shapes, both verified against a real parse:
 *
 *  - `(identifier)` — a bare call (`add(1, 2)`), including a call through a
 *    function-pointer VARIABLE (`fnptr(1, 2)` where `fnptr` was declared
 *    `int (*fnptr)(int, int) = add;`) — the callee position is still a
 *    plain `identifier` either way, confirmed by parsing both forms; this
 *    engine cannot and does not try to tell "calls a function" from "calls
 *    through a function-pointer variable holding that function" apart,
 *    same bare-name-only limitation as every other language here. Also
 *    matches a macro invoked with call syntax (`MIN(a, b)`) — tree-sitter
 *    does not run the C preprocessor, so `MIN` parses as an ordinary
 *    identifier callee; this is not a C++-style false-positive risk the way
 *    `Point(1, 2)`-style construction is, though — a macro name almost never
 *    coincides with a real `Function` node's name, so it simply resolves to
 *    nothing (counted as unresolved), not to a wrong target.
 *  - `(field_expression field: (field_identifier))` — a call through a
 *    struct member (`p->method_ptr()` / `p.method_ptr()`, C's closest
 *    equivalent to a method call: invoking a function-pointer struct
 *    field), verified against a real parse (`assignment left:
 *    (field_expression ...)` uses the identical node shape for a plain
 *    field WRITE, confirmed distinct from this file's call pattern by the
 *    surrounding `call_expression`, so no collision).
 *
 * A function passed *by reference* as a direct (non-nested) call argument
 * (`register_handler("/x", on_request)`) mirrors every other C-family
 * language here: `argument_list`'s children are plain expressions, no
 * labeled/named arguments exist in C (confirmed via node-types.json), so no
 * guard is needed.
 *
 * -- module relationships: `#include` (XSPEC-414 R2) -----------------------
 *
 * `preproc_include`'s `path:` field is one of `string_literal` (a quoted,
 * "local" include, `#include "foo.h"`) or `system_lib_string` (an
 * angle-bracket "system" include, `#include <stdio.h>`) — confirmed via
 * node-types.json and a real parse. Both are captured as `@reference.import`
 * with no attempt to distinguish them in the query itself: resolving the
 * captured text against the indexed file set (done by `extractProject`, not
 * here — see `tag-query-engine.ts`'s `ImportCapture` doc comment) already
 * makes a system header a silent no-op, since `<stdio.h>` essentially never
 * matches a path inside the project being indexed.
 */
export const C_TAGS_QUERY = `
; -- function definitions ----------------------------------------------------

(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @definition.function

; a pointer-returning function, e.g. \`int* makePtr(int x) {...}\` — one
; pointer_declarator layer deeper than the plain case above. A double
; pointer return is a documented, un-covered Open Question (see module doc
; comment).
(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @name))) @definition.function

; -- struct / union / enum ----------------------------------------------------

(struct_specifier name: (type_identifier) @name) @definition.class

(union_specifier name: (type_identifier) @name) @definition.class

(enum_specifier name: (type_identifier) @name) @definition.class

; -- calls ---------------------------------------------------------------------

; \`add(1, 2)\` — a bare call, including through a function-pointer variable
; or a macro invoked with call syntax (see module doc comment for both).
(call_expression function: (identifier) @name) @reference.call

; \`p->handler()\` / \`p.handler()\` — a call through a struct member
; (C's nearest equivalent to a method call, via a function-pointer field).
(call_expression
  function: (field_expression
    field: (field_identifier) @name)) @reference.call

; a function passed *by reference* as a direct (non-nested) call argument,
; e.g. \`register_handler("/x", on_request)\`. No named-argument guard needed
; — C has no labeled call arguments (see module doc comment).
(call_expression
  (argument_list (identifier) @reference.call.arg))

; -- module relationships: #include -------------------------------------------

(preproc_include path: (string_literal) @reference.import)

(preproc_include path: (system_lib_string) @reference.import)
`;

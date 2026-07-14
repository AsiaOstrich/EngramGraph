/**
 * Ruby tag query (tree-sitter Query API, S-expression syntax) — XSPEC-333
 * R2c batch 3 (Ruby/PHP/Dart, the last mainstream-language batch). The
 * second *dynamic* language on this engine after Python (python.ts) — same
 * capture-naming convention (`@definition.function`, `@definition.class`,
 * `@name`, `@reference.call`, `@reference.call.arg`). Node-type names below
 * were read from `tree-sitter-ruby`'s `src/node-types.json` (0.23.1 — see
 * grammars.d.ts's doc comment for why this version is pinned) and verified
 * against real parses via `Parser.Query.matches`, not guessed.
 *
 * -- definitions --------------------------------------------------------------
 *
 * `class`/`module`'s `name:` field is normally a `(constant)` (Ruby
 * capitalizes class/module names by lexical convention, enforced by the
 * grammar as a distinct node type from a plain `identifier`) — but a
 * **namespaced** declaration (`class Foo::Bar`) wraps the name in
 * `scope_resolution` instead, confirmed against a real parse
 * (`class name: (scope_resolution scope: (constant) name: (constant))`), a
 * DIFFERENT node type from the simple case. A first-draft pattern matching
 * only `name: (constant)` was verified to produce **zero** `@definition.class`
 * captures for `class Foo::Bar` — meaning a method inside it would fail to
 * scope-qualify to `Bar.method` at all (falling back to a bare, unqualified
 * id) — a real gap, fixed here with a second explicit pattern extracting
 * `scope_resolution`'s own `name:` field (always the innermost `constant`,
 * confirmed against node-types.json — `Foo::Bar::Baz` nests, but this file
 * does not chase multi-level nesting beyond one `scope_resolution`, an
 * accepted narrow gap for a rare construct).
 *
 * `method` (an ordinary `def foo; ...; end`, covers both module-level
 * functions AND instance methods — Ruby, like Python, has no separate
 * "class method" node type; a method's `body_statement` inside a `class`
 * body is what range-containment `qualifyFunctions` turns into
 * `file#ClassName.method_name`) and `singleton_method` (`def self.foo; ...;
 * end`, Ruby's class-method syntax) are BOTH captured as
 * `@definition.function` — verified against a real parse that
 * `singleton_method` scope-qualifies to `ClassName.method_name` exactly like
 * an ordinary `method` does (its enclosing `class` is found the same way by
 * range containment), so no separate id scheme is needed for it.
 *
 * **A real, previously-undocumented gap found by adversarial review, not
 * exercised by this file's first-draft tests or its real-world-smoke
 * excerpt**: `method`/`singleton_method`'s `name:` field is NOT always a
 * bare `identifier` — a setter method (`def name=(v)`) has `name: (setter
 * name: (identifier))` and an operator method (`def ==(other)`) has `name:
 * (operator)`, both DIFFERENT node types this file's first-draft pattern
 * (`name: (identifier)`) silently did not match at all, verified against a
 * real parse (an entire `def name=`/`def ==` method produced ZERO
 * definition captures before this fix — not merely mis-scoped, completely
 * invisible to this engine). Fixed by capturing the WHOLE `setter`/
 * `operator` wrapper node as `@name` rather than a nested identifier inside
 * it: `setter`'s own text is the FULL correct method name INCLUDING the
 * trailing `=` (`"name="`, not `"name"` — verified against a real parse),
 * which matters a great deal here — capturing just the nested identifier
 * would wrongly collapse a setter onto the exact same qualified id as an
 * unrelated getter of the same base name (`file#Foo.name` for both `def
 * name` and `def name=`), a strictly worse outcome than not capturing it at
 * all. `operator`'s own text (`"=="`, `"<=>"`, etc.) is likewise the correct
 * full operator-method name. Applied to both `method` and `singleton_method`
 * (`def self.name=`/`def self.==` were verified against real parses to
 * share the identical `setter`/`operator` shape).
 *
 * `class << self ... end` (Ruby's "reopen the singleton class" idiom,
 * commonly used to define several class methods at once without repeating
 * `self.` on each) is **not** itself captured as `@definition.class` (this
 * file only captures `class`/`module`) — but this is transparent to
 * range-containment, not a gap: verified against a real parse that a
 * `method` defined inside `class Foo; class << self; def bar; end; end; end`
 * still scope-qualifies to `Foo.bar` (the nearest *captured* ancestor is the
 * outer `class`, since the uncaptured `singleton_class` wrapper in between
 * simply doesn't participate in the ancestor search) — the same "uncaptured
 * transparent wrapper" treatment as Kotlin's anonymous `companion_object`
 * (see queries/kotlin.ts's module doc comment).
 *
 * A lambda/proc literal bound to a variable (`log = ->(m) { puts(m) }`)
 * mirrors JS/C#/Python's "value bound to a variable" pattern via
 * `assignment left: (identifier) @name right: (lambda) @definition.function`.
 * Ruby's multi-assignment destructuring (`a, f = 1, ->(m) {}`) wraps the
 * left side in a DIFFERENT node type, `left_assignment_list`, not
 * `identifier` — verified against a real parse that this pattern produces
 * **zero** matches for that shape (not a cross-paired wrong name the way
 * Go's original short_var_declaration draft was), the same "safe by
 * construction, verified not asserted" finding as Rust's/PHP's/Dart's own
 * destructuring-exclusion checks. `lambda { |m| ... }`/`proc { |m| ... }`
 * (the block-call spelling of a callable, as opposed to the `->(){}`
 * "stabby lambda" literal) do NOT match this pattern at all — their AST
 * shape is an ordinary `call` with a `block:` — so a proc/lambda built this
 * way and bound to a variable is a documented false-negative (not
 * captured), the same "only the literal-syntax form is recognized, not
 * every equivalent spelling" precision cut every other language's own
 * closure-binding pattern already makes.
 *
 * -- calls ----------------------------------------------------------------
 *
 * Ruby's `call` node has `method:`/`receiver:`/`operator:` fields but NO
 * required receiver — meaning ONE pattern, `(call method: (identifier)
 * @name) @reference.call`, uniformly covers a bare call (`helper(x)`), a
 * `.`-receiver call (`obj.method(x)`), a safe-navigation call
 * (`obj&.method(x)`), AND a scope-resolution call (`Foo::bar(x)`) — verified
 * against real parses of all four side by side that the `call` node's own
 * shape (`method:`/`arguments:` fields) is IDENTICAL regardless of which
 * operator glues receiver to method, or whether a receiver is present at
 * all. This is actually SIMPLER than Kotlin's equivalent finding (which
 * needed an explicit `["." "?."]` alternation because its grammar's
 * `navigation_expression` node requires the operator token as a literal
 * sibling) — omitting the `receiver:`/`operator:` fields entirely imposes NO
 * constraint in tree-sitter's query DSL, so this file needs no wildcard or
 * alternation at all for that part. A **chained** receiver (`a.b.c(x)`) was
 * also verified: the outer `call`'s `receiver:` field is itself a nested
 * `call` node (`a.b`, a zero-arg attribute-style read — see below), and
 * since this pattern places no constraint on `receiver:`'s shape at all,
 * both the outer and inner `call` nodes are captured independently and
 * correctly (only the outer one's `method:` — `c` — is the one that had
 * `(x)` arguments; matches Ruby's actual semantics of that expression).
 *
 * **A real, Ruby-specific consequence found during this file's development,
 * not present in any other language on this engine**: Ruby has NO distinct
 * "attribute access" / "field read" node type at all — `obj.attr` (no
 * parens, no arguments) parses to the exact same `call` shape as a
 * zero-arg method call (`call receiver: (identifier) method: (identifier)`,
 * no `arguments:` field at all — confirmed against a real parse of
 * `a.b.c(x)`, where the inner `a.b` produces exactly this shape). This is
 * NOT a false-positive to filter out, unlike every other language's
 * "instantiation looks like a call" ambiguity below — it is semantically
 * CORRECT for Ruby: `person.name` really IS invoking a method named `name`
 * (Ruby has no public fields; every "property read" is a real method call,
 * typically one synthesized by `attr_accessor`/`attr_reader`). The practical
 * consequence is that this file's `@reference.call` pattern fires on every
 * single dot-access anywhere in a Ruby file — a materially higher raw call
 * count per file than any other language on this engine (JS/Python/etc. all
 * have a distinct non-call attribute-read shape that this pattern doesn't
 * match) — but each individual capture is a real, correct Ruby method
 * invocation, not a fabricated one, PROVIDED it is actually invoked and not
 * merely a plain assignment TARGET (see the very next paragraph — this
 * claim was originally stated without that carve-out and was WRONG until an
 * adversarial review caught it).
 *
 * **A real, verified false-POSITIVE found by adversarial review — the
 * "everything is a call" property above cuts the OTHER way for a plain
 * assignment**: `obj.name = x` parses its LHS, `obj.name`, to the exact same
 * `call` shape as a genuine zero-arg invocation (`assignment left: (call
 * receiver: (identifier) method: (identifier)) right: ...`, confirmed
 * against a real parse) — but Ruby actually dispatches a plain assignment to
 * a COMPLETELY DIFFERENT method, `name=` (see the setter-definition finding
 * below), NEVER invoking `name` at all. Before a fix, this fabricated a real
 * CALLS edge to a coincidentally-same-named getter every time a plain setter
 * assignment appeared in a method body alongside a getter of the same base
 * name (`self.name = x` inside some method, plus an unrelated `def name`
 * elsewhere in the same class) — confirmed end-to-end via
 * `extractCodeGraph`, not merely at the query-match level. Fixed in
 * tag-query-engine.ts's `runTagQuery` (language-agnostic, not this file —
 * see that function's `isPlainAssignmentTarget` doc comment for the full
 * mechanism and why it belongs in the shared engine, not a per-language
 * query), which drops any `@reference.call` capture that is itself the LHS
 * of a plain (`=`) assignment, single or multi-target. Deliberately scoped
 * to PLAIN assignment only: `obj.count += 1` (Ruby's distinct
 * `operator_assignment` node type) genuinely reads through the getter
 * before writing back through the setter, verified against a real parse
 * that its `left:` field is the same `call` shape — a real invocation this
 * time, correctly still captured, not excluded by the fix.
 *
 * **A real, verified false-NEGATIVE found while testing this file, not
 * merely a variant of the false-positive risk above**: a method invoked with
 * NO receiver, NO parentheses, and NO arguments (`helper` alone, as a bare
 * statement) is syntactically INDISTINGUISHABLE from a local variable read
 * in this grammar — confirmed against a real parse that it produces a plain
 * `identifier` node, not a `call` node at all (Ruby's own parser resolves
 * this exact ambiguity at parse time using a live local-variable-name table,
 * information a syntax-only tree-sitter grammar does not have access to).
 * This means implicit-self, no-parens method invocation — a common, everyday
 * Ruby style, especially for attr_accessor-style getters and DSL-like method
 * chains — is NOT captured as a call at all: a documented false negative,
 * not a bug in this file's patterns (there is no `call` node for it to
 * match). The ambiguity resolves the OTHER way the moment either a receiver
 * (`self.helper`), any argument, parenthesized or not (`helper()`, Ruby's
 * "command call" syntax `helper x`), OR — a refinement found while building
 * this file's real-world-smoke-test fixture from an actual Sinatra source
 * file, not from a hand-written toy case — a **`?` or `!` suffix on the
 * method name** (`safe?`, `save!`) is present: verified against a real
 * parse that `safe?` alone (bare, no receiver, no parens, no args) DOES
 * produce an ordinary `call method: (identifier)` node, unlike `helper`
 * alone. This is not an inconsistency in the grammar — it is exploiting a
 * genuine, unrelated Ruby rule this grammar already enforces elsewhere:
 * local variable names can never end in `?`/`!` (only method names can), so
 * a bare `?`/`!`-suffixed word has NO local-variable reading to be ambiguous
 * with in the first place, and tree-sitter-ruby resolves it as a call
 * unconditionally. Predicate methods (`?`-suffixed) and dangerous/mutating
 * methods (`!`-suffixed) are an extremely common Ruby naming convention, so
 * this materially narrows the false-negative's real-world impact versus a
 * naive "every bare word invocation is invisible" reading of the finding
 * above — verified with real Sinatra source in
 * test/real-world-smoke.test.ts, not merely asserted.
 *
 * -- Ruby-specific false-positive risks explicitly named in the task,
 * evaluated one at a time -------------------------------------------------
 *
 * **Keyword arguments** (`register(handler: x, path: y)`): verified against
 * a real parse that each keyword argument is wrapped in its own `pair` node
 * (`pair key: (hash_key_symbol) value: (identifier)`), itself a direct child
 * of `argument_list` — a DIFFERENT node type from a bare positional
 * `identifier` child. This file's by-reference-argument pattern,
 * `(argument_list (identifier) @reference.call.arg)`, therefore excludes
 * keyword arguments **structurally, for free** — double-checked with an
 * actual `Parser.Query` run against `register(handler: x, path: y)`
 * side-by-side with `register(x, y)`: the keyword form captures nothing,
 * the positional form captures both `x` and `y`. No `!name`-style predicate
 * needed (Kotlin's/C#'s mechanism), matching Python's own free structural
 * exclusion instead.
 *
 * **Symbol arguments** (`register(:handler_method)`, `send(:foo)`,
 * `respond_to?(:bar)`) — evaluated and DELIBERATELY NOT captured as
 * by-reference call targets, despite being semantically closer to "a method
 * reference" than a plain value in some of these idioms (`send`/`respond_to?`).
 * Verified against a real parse that a bare symbol is its own distinct node
 * type, `simple_symbol` — NOT `identifier` — so this file's existing
 * `(argument_list (identifier))` pattern already excludes it structurally,
 * with no extra work required to keep it excluded. The decision NOT to add a
 * parallel `(argument_list (simple_symbol) @reference.call.arg)` pattern
 * (mirroring Kotlin's `::method`/Java's `method_reference`/PHP's
 * first-class-callable capture) is deliberate, not an oversight: unlike
 * those languages' reference syntaxes (which are used almost exclusively to
 * pass a callable), a bare Ruby symbol is used PERVASIVELY for purposes that
 * have nothing to do with calling a method — hash keys (`{status: :ok}`),
 * `attr_accessor`/`attr_reader`/`attr_writer` declarations, enum-like tags,
 * Rails-style DSL arguments (`resources :users`, `validates :name,
 * presence: true`), RSpec/Minitest test metadata (`it "...", :focus do`) —
 * capturing every bare symbol as a call-target reference would fabricate a
 * CALLS edge any time one of these unrelated symbols coincidentally matches
 * a real method name elsewhere in the indexed corpus (e.g. `attr_accessor
 * :name` colliding with an unrelated `def name` elsewhere), a MUCH higher
 * false-positive rate than any other language's by-reference pattern carries
 * today. Left as an explicit Open Question, resolved as "do not implement"
 * per this engine's precision-over-recall stance, not deferred for lack of
 * time.
 *
 * **`method_missing`/dynamic dispatch** (`send(method_name_variable)`,
 * `public_send(...)`, `method_missing` itself) — not special-cased. `send`/
 * `public_send`/`method_missing` are themselves ordinary identifiers,
 * captured as an ordinary call to a method literally named `send` (which is
 * correct — Ruby really is invoking `Kernel#send` there), but this file
 * makes no attempt to resolve WHICH method `send` ultimately dispatches to
 * (whether the argument is a literal symbol, deliberately excluded above, or
 * a runtime variable, which is unresolvable by static syntax analysis in any
 * language). Same category as every other language's total absence of
 * dynamic-dispatch resolution — not a Ruby-specific gap, an inherent limit
 * of a syntax-only tool.
 *
 * **The explicit block-pass operator** (`register(&handler)`) — found by
 * adversarial review as a genuine gap in the by-reference-argument pattern's
 * first draft (`(argument_list (identifier))` alone does not match — the
 * identifier is wrapped in a `block_argument` node, one level deeper, not a
 * *direct* child of `argument_list`, confirmed against a real parse). Unlike
 * the rejected bare-symbol idea, `&` is arguably a STRONGER by-reference
 * signal than the plain bare-identifier case this file already captures:
 * it unambiguously means "convert this to a block / pass this callable as
 * the method's block", never a plain data value — so a dedicated pattern
 * was added (see the query body) rather than left as an Open Question.
 *
 * **Left as an explicit, deliberately narrow Open Question, found by
 * adversarial review but NOT fixed in this batch**: a call whose method name
 * happens to be capitalized (`Foo::Bar(x)`) has `method: (constant)`, not
 * `(identifier)` — confirmed against a real parse — so this file's call
 * pattern (which only matches `method: (identifier)`) does not capture it.
 * Defining a method with a capitalized name is a significant departure from
 * Ruby's own naming convention (virtually never done in real code outside
 * contrived examples), so the real-world impact is low; adding a parallel
 * `method: (constant)` pattern was evaluated and deferred rather than
 * shipped under-verified, consistent with this batch's general preference
 * for a documented gap over a rushed, low-value widening.
 *
 * -- found during this file's development, not named in the original task
 * (analogous to Python's/Kotlin's/Go's/Rust's/C++'s own bare-call-vs-
 * instantiation ambiguity, but structurally NARROWER here) ----------------
 *
 * Ruby has no bare `Foo()` instantiation syntax at all (no "new" keyword
 * elision the way Kotlin has) — object creation is always the explicit
 * `Foo.new(...)`, which is simply an ordinary member call to a real method
 * literally named `new` (inherited from `Class`, almost never redefined by
 * user code) — captured by the same member-call pattern as any other
 * `.method()` call, with no special ambiguity to document beyond noting
 * that `new` only resolves to something if a real function literally named
 * `new` exists elsewhere in the indexed corpus (exceedingly rare in
 * practice, since user code defines `initialize`, not `new`, to customize
 * construction) — a narrower, lower-risk version of the shared
 * instantiation-ambiguity limitation every prior language on this engine
 * documents, not a new quirk requiring separate handling.
 *
 * -- comment node type -----------------------------------------------------
 *
 * Ruby's comment node is named plain `comment` (confirmed against
 * node-types.json), already covered by tag-query-engine.ts's
 * `COMMENT_NODE_TYPES` — no engine change needed for Ruby (unlike Java's/
 * Dart's own discoveries), matching the JS/TS/C#/Python/Go/Kotlin precedent.
 *
 * -- Open Question: constructors --------------------------------------------
 *
 * Unlike Java/C#/C++ (whose constructors are distinctly-named nodes this
 * file's siblings deliberately capture), Ruby has no `constructor`-shaped
 * node at all — `initialize` is simply an ordinary `method` named
 * "initialize", already captured and scope-qualified by this file's existing
 * `method` pattern with no special casing required. Nothing left undone
 * here.
 */
export const RUBY_TAGS_QUERY = `
; -- class / module definitions (incl. namespaced, e.g. "class Foo::Bar") ------

(class name: (constant) @name) @definition.class
(class name: (scope_resolution name: (constant) @name)) @definition.class

(module name: (constant) @name) @definition.class
(module name: (scope_resolution name: (constant) @name)) @definition.class

; -- method definitions (module-level functions, instance methods, and
; "def self.x" class methods alike — scope-qualification is reconstructed
; from byte-range containment by the shared engine, not here) -----------------

(method name: (identifier) @name) @definition.function
(singleton_method name: (identifier) @name) @definition.function

; setter methods (\`def name=(v)\`) and operator methods (\`def ==(other)\`) —
; the \`name:\` field is a DIFFERENT node type in each case (\`setter\`/
; \`operator\`, not a bare \`identifier\`), found by adversarial review (a
; real, previously-undocumented silent gap, not exercised by either the
; first draft's test fixtures or the real-world-smoke excerpt). The whole
; wrapper node (not a nested identifier inside it) is captured as \`@name\`
; because ITS OWN text is the full, correct method name including the
; trailing \`=\`/operator symbol (\`setter\`'s own text is \"name=\", not just
; \"name\" — verified against a real parse; capturing the nested identifier
; instead would wrongly collapse a setter onto the SAME id as an unrelated
; getter of the same base name).
(method name: (setter) @name) @definition.function
(method name: (operator) @name) @definition.function
(singleton_method name: (setter) @name) @definition.function
(singleton_method name: (operator) @name) @definition.function

; a lambda literal bound to a variable: \`log = ->(m) { puts(m) }\`. Ruby's
; multi-assignment destructuring (\`a, f = 1, ->(){}\`) uses a DIFFERENT
; left-hand node type (left_assignment_list, not identifier) and is safely
; excluded — verified against a real parse, not assumed. \`lambda { }\`/
; \`proc { }\` (the block-call spelling) are NOT matched here — see module doc
; comment.
(assignment left: (identifier) @name right: (lambda) @definition.function)

; -- calls ---------------------------------------------------------------------

; covers EVERY shape uniformly — bare (\`helper(x)\`), \`.\`-receiver
; (\`obj.method(x)\`), safe-navigation (\`obj&.method(x)\`), scope-resolution
; (\`Foo::bar(x)\`) calls, AND zero-arg "attribute" reads (\`obj.attr\` — itself
; a real method call in Ruby, not a false positive; see module doc comment)
; — because the \`method:\` field is present regardless of receiver/operator,
; and this pattern places no constraint on \`receiver:\`/\`operator:\` at all.
(call method: (identifier) @name) @reference.call

; a function/lambda passed *by reference* as a direct positional call
; argument (mirrors JS/Go/Python/Rust/Kotlin/C#/PHP/Dart's equivalent
; pattern). Keyword arguments (\`register(handler: x)\`) wrap their value in a
; \`pair\` node (a different node type, not a direct \`identifier\` child of
; argument_list) and are excluded for free — verified against a real parse,
; the same structural exclusion Python's \`keyword_argument\` gives. Bare
; symbols (\`register(:handler_method)\`) are a DIFFERENT node type
; (\`simple_symbol\`, not \`identifier\`) and are deliberately NOT captured here
; — see module doc comment for why.
(argument_list (identifier) @reference.call.arg)

; Ruby's OWN idiomatic by-reference syntax, the explicit block-pass operator
; (\`register(&handler)\`) — found by adversarial review, arguably a stronger
; signal than the bare-identifier case above since \`&\` unambiguously means
; \"convert this to a block / pass this Proc as the block\", not a data value.
; \`block_argument\`'s child is optional (the Ruby 2.7+ anonymous \`&\` shorthand
; has none) and, when present, may be any expression — only the bare
; \`identifier\` shape is captured here, the same \"direct value only, don't
; chase arbitrary expressions\" precision cut as every other by-reference
; pattern on this engine.
(argument_list (block_argument (identifier) @reference.call.arg))
`;

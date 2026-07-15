/**
 * SCIP symbol string parsing + canonical-id normalization (XSPEC-333 R3 PoC,
 * OQ-2 from R1: "a future non-tree-sitter provider will have its own native
 * id scheme that won't line up with tree-sitter's — a real second provider
 * is needed to design the normalization layer against." SCIP is that real
 * second provider.
 *
 * ## SCIP symbol string format (verified against real `scip-dotnet` output,
 * not just spec-reading)
 *
 * A SCIP symbol string is `<scheme> <manager> <package-name> <package-version>
 * <descriptor-path>`, space-separated, e.g. (a real string decoded from this
 * PoC's fixture `.scip` file):
 *
 *   scip-dotnet nuget . . Services/OrderService#Validate().
 *
 * (`.` stands in for an absent manager/name/version — scip-dotnet does not
 * resolve project-local symbols to a real NuGet package.) The
 * `<descriptor-path>` is itself a sequence of descriptors, each ending in a
 * sigil that names its kind:
 *
 *   - `Namespace` — trailing `/`             e.g. `Services/`
 *   - `Type`      — trailing `#`             e.g. `OrderService#`
 *   - `Term`      — trailing `.`             e.g. `Id.` (field/property)
 *   - `Method`    — trailing `().` (with an  e.g. `Validate().`,
 *                   optional `(+N)` overload      `Add(+1).`
 *                   disambiguator before `.`)
 *   - `Parameter` — `(name)`, terminal, no   e.g. `(order)`
 *                   trailing sigil of its own
 *   - `TypeParameter` — `[name]`             (not seen in this PoC's sample)
 *   - `Meta`      — trailing `:`             (not seen)
 *   - `Macro`     — trailing `!`             (not seen)
 *
 * `local N` symbols (e.g. `"local 0"`) are a completely different,
 * document-scoped-local convention with no descriptor path at all — see
 * {@link isLocalSymbol} in `scip-reader.ts`; callers must filter those out
 * before calling {@link parseDescriptors}.
 *
 * ## Canonical id design
 *
 * tree-sitter's own ids (see `extractor.ts`/`tag-query-engine.ts`) are
 * `${filePath}#${Class.Method}` for functions and `${filePath}#class:${Class}`
 * for classes, where `Class.Method` drops any C# *namespace* entirely (only
 * `@definition.class`-captured scopes contribute a name segment — verified by
 * reading `queries/csharp.ts`, which does not capture `namespace_declaration`)
 * and does not disambiguate overloads (two overloads of the same method
 * collapse onto one id — a documented, pre-existing tree-sitter limitation,
 * see `extractor.ts`'s R2b comment). So the normalization rule here:
 *
 *   1. drop `Namespace` segments entirely (they have no counterpart in
 *      tree-sitter's id scheme),
 *   2. drop the overload `disambiguator` on `Method` segments (so overloads
 *      collapse the same way tree-sitter's do, not differently),
 *   3. drop `Parameter`/`Term`/`Meta`/`Macro`/`TypeParameter` segments (no
 *      counterpart; a `Function`/`Class` node's id is built from `Type`/
 *      `Method` segments only),
 *   4. join remaining segment names with `.`, in order,
 *   5. prefix with the symbol's *defining file's* relative path + `#`
 *      (a `Class` id additionally gets a literal `class:` prefix on the
 *      qualified-name part, matching `extractor.ts`).
 *
 * This module implements that rule as a pure string transform, independent of
 * any parallel tree-sitter parse, and is unit-tested against the real symbol
 * strings this PoC's fixture `.scip` file contains. **`scip-ingest.ts`'s
 * actual graph-merge path does NOT use this module to compute the ids it
 * writes** — it instead resolves both ends of a call via row-containment
 * against a live tree-sitter parse of the same source (see that file's
 * module doc for why: a second, independently-derived string parser
 * introduces a real risk of producing a byte-different id for what should be
 * the *same* real-world symbol — e.g. a nested-class or namespace-edge-case
 * this parser gets subtly wrong — which would silently create a duplicate,
 * disconnected graph node instead of merging onto the existing tree-sitter
 * one). This module exists as (a) the literal "id normalization layer"
 * artifact this PoC set out to design, (b) a cross-check: `test/scip-symbol.test.ts`
 * asserts this pure-string rule's output equals the real tree-sitter ids for
 * every symbol in the fixture project, so the two independent derivations
 * are shown to agree here, and (c) the path a future *cross-repo* or
 * *no-parallel-tree-sitter-parse* use of SCIP would have to take (this PoC's
 * row-containment shortcut only works because the same source tree is parsed
 * by both providers in the same process).
 */

export type DescriptorKind =
  | "namespace"
  | "type"
  | "term"
  | "method"
  | "parameter"
  | "typeParameter"
  | "meta"
  | "macro";

export interface Descriptor {
  kind: DescriptorKind;
  name: string;
  /** Overload disambiguator on a `method` descriptor, e.g. `"+1"`. Absent for the first overload. */
  disambiguator?: string;
}

/** The parsed, structured form of a full symbol string. */
export interface ParsedSymbol {
  scheme: string;
  manager: string;
  packageName: string;
  packageVersion: string;
  descriptors: Descriptor[];
}

const SIGIL_CHARS = "/#.([:!";

/**
 * Scan one `<name>` token starting at `i`, handling SCIP's
 * `<escaped-identifier> ::= '`' (<escaped-character>)+ '`'` form (spec's
 * grammar comment in `scip.proto`) — e.g. Java's implicit-constructor symbol
 * `` `<init>` `` (real string seen in this PoC's Java fixture, since
 * `<`/`>`/`(`-adjacent chars in a raw identifier are exactly the "at least
 * one non-identifier-character" case the spec requires escaping for).
 * Backticks inside an escaped identifier are themselves escaped by
 * doubling (`` '' `` per spec: "escape backticks with double backtick").
 * Returns the DECODED name (backticks stripped, `` `` `` un-escaped to a
 * literal backtick) and the index just past the token, so the caller's
 * normal sigil-dispatch logic runs unchanged on whatever follows.
 *
 * XSPEC-333 R3 Java PoC finding: before this function existed, the bare
 * "scan until a sigil char" loop below had no special case for backticks
 * (not in {@link SIGIL_CHARS}), so an escaped identifier like `` `<init>` ``
 * silently kept its literal backticks (and any embedded sigil-like
 * characters) in the parsed `name` instead of the intended semantic name —
 * never hit by C# (`scip-dotnet`'s sample never emits escaped identifiers)
 * but real and reachable once Java constructors entered the fixture set.
 */
function scanName(path: string, i: number): [name: string, next: number] {
  if (path[i] !== "`") {
    const start = i;
    while (i < path.length && !SIGIL_CHARS.includes(path[i]!)) i++;
    return [path.slice(start, i), i];
  }
  let decoded = "";
  let j = i + 1;
  while (j < path.length) {
    if (path[j] === "`") {
      if (path[j + 1] === "`") {
        decoded += "`";
        j += 2;
        continue;
      }
      return [decoded, j + 1]; // real closing backtick
    }
    decoded += path[j];
    j++;
  }
  return [decoded, j]; // unterminated (malformed input) — best effort
}

/**
 * Split a descriptor-path string into ordered {@link Descriptor} segments.
 *
 * Hand-written scanner rather than one mega-regex: the `Method` vs
 * `Parameter` cases both use `(...)` but are told apart by whether a `.`
 * immediately follows the closing paren (`Method`) or not (`Parameter`,
 * terminal) — a lookahead that is easy to get subtly wrong in a single
 * regex and easy to verify by reading a small loop.
 */
export function parseDescriptors(path: string): Descriptor[] {
  const out: Descriptor[] = [];
  let i = 0;
  while (i < path.length) {
    const [name, nextI] = scanName(path, i);
    i = nextI;
    if (i >= path.length) break; // malformed / trailing bare name with no sigil — drop it

    const ch = path[i]!;
    if (ch === "/") {
      out.push({ kind: "namespace", name });
      i++;
    } else if (ch === "#") {
      out.push({ kind: "type", name });
      i++;
    } else if (ch === ".") {
      out.push({ kind: "term", name });
      i++;
    } else if (ch === ":") {
      out.push({ kind: "meta", name });
      i++;
    } else if (ch === "!") {
      out.push({ kind: "macro", name });
      i++;
    } else if (ch === "[") {
      const close = path.indexOf("]", i);
      i = close === -1 ? path.length : close + 1;
      out.push({ kind: "typeParameter", name });
    } else if (ch === "(") {
      // Known remaining scope limit (not fixed here, not hit by any current
      // fixture): unlike the outer name token above, the disambiguator/
      // parameter-name text INSIDE the parens is still found via a bare
      // `indexOf(")")`, so a method-disambiguator or parameter name that is
      // ITSELF a backtick-escaped identifier containing a literal `)` would
      // be split incorrectly. Escaped disambiguators/parameter names were
      // not observed in either this PoC's C# or Java fixture data.
      const close = path.indexOf(")", i);
      if (close === -1) {
        i = path.length;
        break;
      }
      const inner = path.slice(i + 1, close);
      const afterClose = path[close + 1];
      if (afterClose === ".") {
        // Method: `name(<disambiguator>).` — `name` was already read above.
        out.push({ kind: "method", name, disambiguator: inner || undefined });
        i = close + 2;
      } else {
        // Parameter: bare `(paramName)`, no name segment before the paren —
        // `name` collected above is empty; `inner` IS the parameter's name.
        out.push({ kind: "parameter", name: inner });
        i = close + 1;
      }
    }
  }
  return out;
}

/** Parse a full SCIP symbol string (see module doc for the format). */
export function parseSymbol(symbol: string): ParsedSymbol | null {
  // scheme, manager, package-name, package-version are the first 4
  // whitespace-separated tokens; the remainder (which may itself be empty,
  // e.g. a bare package reference with no descriptor) is the descriptor path.
  const parts = symbol.split(" ");
  if (parts.length < 4) return null;
  const [scheme, manager, packageName, packageVersion, ...rest] = parts as [string, string, string, string, ...string[]];
  return {
    scheme,
    manager,
    packageName,
    packageVersion,
    descriptors: parseDescriptors(rest.join(" ")),
  };
}

/** What kind of graph node (if any) a symbol's *own* definition corresponds to. */
export type SymbolGraphKind = "function" | "class" | "other";

/**
 * Classify a symbol by its last descriptor segment — the segment that
 * "owns" the symbol (e.g. for `Services/OrderService#Validate().(order)`,
 * the last segment is the `parameter` one, so this symbol is the
 * *parameter*, not the method itself; the method's own symbol string ends
 * at `Validate().` with `method` as the last segment).
 */
export function classifySymbol(parsed: ParsedSymbol): SymbolGraphKind {
  const last = parsed.descriptors.at(-1);
  if (!last) return "other";
  if (last.kind === "method") return "function";
  if (last.kind === "type") return "class";
  return "other";
}

/**
 * Build the canonical `Class.Method`-style qualified name (tree-sitter
 * convention) from a symbol's descriptors, dropping `namespace` segments and
 * any overload `disambiguator`, per the module doc's normalization rule.
 * Returns `null` for symbols with no `type`/`method` segment at all (pure
 * namespace refs, external library refs with only a `term`, etc.).
 */
export function qualifiedNameFor(parsed: ParsedSymbol): string | null {
  const names = parsed.descriptors
    .filter((d) => d.kind === "type" || d.kind === "method")
    .map((d) => d.name);
  return names.length > 0 ? names.join(".") : null;
}

/**
 * Full canonical id, matching tree-sitter's own `${file}#...` convention —
 * see module doc. `definingFile` must be the repo-relative path of the file
 * that *defines* this symbol (from the SCIP document whose occurrence for
 * this symbol carries the `Definition` role), NOT the file of any particular
 * reference to it.
 */
export function canonicalIdForSymbol(
  symbol: string,
  definingFile: string,
): { kind: "function" | "class"; id: string } | null {
  const parsed = parseSymbol(symbol);
  if (!parsed) return null;
  const kind = classifySymbol(parsed);
  if (kind === "other") return null;
  const qualified = qualifiedNameFor(parsed);
  if (!qualified) return null;
  return kind === "class"
    ? { kind, id: `${definingFile}#class:${qualified}` }
    : { kind, id: `${definingFile}#${qualified}` };
}

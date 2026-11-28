/**
 * What a file imports, as names (decision 736A): the evidence that picks one definition when a call's name matches
 * several.
 *
 * This is NOT the `@reference.import` / `FileFacts.imports` path. That one feeds Module -> Module `IMPORTS` edges
 * (C `#include`, Bash `source`) and resolves by directory plus a globally unique basename; a Python or TypeScript
 * import has a different job (naming which module a NAME comes from) and must not mint `IMPORTS` edges or change
 * their count. So it is read separately, here, and travels in {@link FileFacts.bindings}.
 *
 * A binding is `[local, spec, name]`:
 *
 *  - `local`  the name the file uses (the alias when there is one);
 *  - `spec`   the module as written: `a.b`, `.sub`, `..pkg`, `.` (Python) or `./x`, `../y.js` (TypeScript);
 *  - `name`   what is taken from the module: an exported name, `""` when the whole module is bound to `local`
 *             (`import a.b as x`, `import * as ns`), `"*"` for a star import / re-export (`local` is `"*"` too),
 *             `"default"` for a TypeScript default import.
 *
 * Python: every `import` / `from ... import` in the file counts, including those inside functions (a lazy import
 * is how Python code breaks a cycle) — the file is treated as one scope. That is an approximation: two functions
 * importing different things under one local name make the name conflicting, and a conflicting name resolves
 * nothing (see `import-resolve.ts`).
 *
 * TypeScript / JavaScript: `import` declarations and `export ... from` re-exports (a barrel file is a chain of
 * them). `require(...)` and dynamic `import()` are not read.
 */

import type Parser from "tree-sitter";

import type { SupportedLanguage } from "./types.js";

/** `[local, spec, name]`, see the module doc. */
export type ImportBinding = [local: string, spec: string, name: string];

/** The language families whose imports are read; every other language gives no bindings. */
export type ImportFamily = "python" | "ecmascript";

export function importFamilyOf(language: SupportedLanguage): ImportFamily | undefined {
  switch (language) {
    case "python":
      return "python";
    case "typescript":
    case "tsx":
    case "javascript":
      return "ecmascript";
    default:
      return undefined;
  }
}

/** The bindings a parsed file declares, in document order, de-duplicated. */
export function extractImportBindings(language: SupportedLanguage, root: Parser.SyntaxNode): ImportBinding[] {
  const family = importFamilyOf(language);
  if (family === undefined) return [];
  const out: ImportBinding[] = [];
  if (family === "python") {
    for (const node of root.descendantsOfType(["import_statement", "import_from_statement"])) {
      if (node.type === "import_statement") pythonImport(node, out);
      else pythonFromImport(node, out);
    }
  } else {
    // import / export declarations are top-level statements only
    for (const node of root.namedChildren) {
      if (node.type === "import_statement") ecmaImport(node, out);
      else if (node.type === "export_statement") ecmaReexport(node, out);
    }
  }
  const seen = new Set<string>();
  return out.filter((b) => {
    const key = b.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// -- Python ---------------------------------------------------------------------------------------------------------

/** `import a.b`, `import a.b as x`, `import a, b` */
function pythonImport(node: Parser.SyntaxNode, out: ImportBinding[]): void {
  for (const child of node.namedChildren) {
    if (child.type === "dotted_name") {
      // `import a.b.c` binds `a`; the receiver `a.b.c.f()` is composed from it at resolution
      const dotted = squash(child.text);
      out.push([dotted.split(".")[0]!, dotted.split(".")[0]!, ""]);
    } else if (child.type === "aliased_import") {
      const name = child.childForFieldName("name");
      const alias = child.childForFieldName("alias");
      if (name && alias) out.push([alias.text, squash(name.text), ""]);
    }
  }
}

/** `from a.b import c, d as e`, `from . import m`, `from ..p import *` */
function pythonFromImport(node: Parser.SyntaxNode, out: ImportBinding[]): void {
  const moduleNode = node.childForFieldName("module_name");
  if (!moduleNode) return;
  const spec = squash(moduleNode.text);
  for (const child of node.namedChildren) {
    if (child.id === moduleNode.id) continue;
    if (child.type === "dotted_name") {
      out.push([squash(child.text), spec, squash(child.text)]);
    } else if (child.type === "aliased_import") {
      const name = child.childForFieldName("name");
      const alias = child.childForFieldName("alias");
      if (name && alias) out.push([alias.text, spec, squash(name.text)]);
    } else if (child.type === "wildcard_import") {
      out.push(["*", spec, "*"]);
    }
  }
}

// -- TypeScript / JavaScript -----------------------------------------------------------------------------------------

/** The text of a string literal node without its quotes. */
function stringValue(node: Parser.SyntaxNode | null): string | undefined {
  if (!node || node.type !== "string") return undefined;
  const text = node.text;
  return text.length >= 2 ? text.slice(1, -1) : undefined;
}

/** `import d, { a as b, c } from "./x"`, `import * as ns from "./x"` */
function ecmaImport(node: Parser.SyntaxNode, out: ImportBinding[]): void {
  const spec = stringValue(node.childForFieldName("source"));
  if (spec === undefined) return;
  const clause = node.namedChildren.find((c) => c.type === "import_clause");
  if (!clause) return; // `import "./side-effect"` binds nothing
  for (const child of clause.namedChildren) {
    if (child.type === "identifier") {
      out.push([child.text, spec, "default"]);
    } else if (child.type === "namespace_import") {
      const id = child.namedChildren.find((c) => c.type === "identifier");
      if (id) out.push([id.text, spec, ""]);
    } else if (child.type === "named_imports") {
      for (const sp of child.namedChildren) {
        if (sp.type !== "import_specifier") continue;
        const name = sp.childForFieldName("name");
        const alias = sp.childForFieldName("alias");
        if (name) out.push([(alias ?? name).text, spec, name.text]);
      }
    }
  }
}

/** `export { a as b } from "./z"`, `export * from "./all"`, `export * as ns from "./n"` */
function ecmaReexport(node: Parser.SyntaxNode, out: ImportBinding[]): void {
  const spec = stringValue(node.childForFieldName("source"));
  if (spec === undefined) return;
  for (const child of node.namedChildren) {
    if (child.type === "export_clause") {
      for (const sp of child.namedChildren) {
        if (sp.type !== "export_specifier") continue;
        const name = sp.childForFieldName("name");
        const alias = sp.childForFieldName("alias");
        if (name) out.push([(alias ?? name).text, spec, name.text]);
      }
    } else if (child.type === "namespace_export") {
      const id = child.namedChildren.find((c) => c.type === "identifier");
      if (id) out.push([id.text, spec, ""]);
    }
  }
  // `export * from "./all"`: a bare `*` token before `from`
  if (!node.namedChildren.some((c) => c.type === "export_clause" || c.type === "namespace_export") && node.children.some((c) => c.type === "*")) {
    out.push(["*", spec, "*"]);
  }
}

/** A dotted name with the whitespace Python allows around the dots removed. */
function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

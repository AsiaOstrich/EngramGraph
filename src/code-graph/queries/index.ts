import type { SupportedLanguage } from "../types.js";
import { JAVASCRIPT_TAGS_QUERY } from "./javascript.js";
import { TYPESCRIPT_TAGS_QUERY } from "./typescript.js";
import { CSHARP_TAGS_QUERY } from "./csharp.js";
import { PYTHON_TAGS_QUERY } from "./python.js";
import { GO_TAGS_QUERY } from "./go.js";
import { JAVA_TAGS_QUERY } from "./java.js";
import { KOTLIN_TAGS_QUERY } from "./kotlin.js";
import { RUST_TAGS_QUERY } from "./rust.js";
import { CPP_TAGS_QUERY } from "./cpp.js";

/**
 * Per-language tag query source (tree-sitter Query S-expression syntax).
 * "typescript" and "tsx" share one query — see typescript.ts's doc comment.
 */
export function tagsQuerySourceFor(language: SupportedLanguage): string {
  switch (language) {
    case "javascript":
      return JAVASCRIPT_TAGS_QUERY;
    case "typescript":
    case "tsx":
      return TYPESCRIPT_TAGS_QUERY;
    case "csharp":
      return CSHARP_TAGS_QUERY;
    case "python":
      return PYTHON_TAGS_QUERY;
    case "go":
      return GO_TAGS_QUERY;
    case "java":
      return JAVA_TAGS_QUERY;
    case "kotlin":
      return KOTLIN_TAGS_QUERY;
    case "rust":
      return RUST_TAGS_QUERY;
    case "cpp":
      return CPP_TAGS_QUERY;
  }
}

export {
  SpecDecisionKnowledgeSource,
  parseKnowledgeDoc,
  indexKnowledgeDocs,
} from "./parser.js";
export type { ParsedKnowledgeDoc, KnowledgeIndexResult } from "./parser.js";
export { classifyRef } from "./linker.js";
export type { ClassifiedRef } from "./linker.js";
export { impactAnalysis } from "./query.js";
export type {
  KnowledgeDoc,
  KnowledgeNodeKind,
  ImpactNode,
  ImpactAnalysisResult,
} from "./types.js";

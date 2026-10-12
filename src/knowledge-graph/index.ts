export {
  SpecDecisionKnowledgeSource,
  parseKnowledgeDoc,
  indexKnowledgeDocs,
} from "./parser.js";
export type { ParsedKnowledgeDoc, KnowledgeIndexResult, DocIdConflict, DocIdSource } from "./parser.js";
export { classifyRef, classifyLeadingRef } from "./linker.js";
export type { ClassifiedRef } from "./linker.js";
export { impactAnalysis } from "./query.js";
export type {
  KnowledgeDoc,
  KnowledgeNodeKind,
  ImpactNode,
  ImpactAnalysisResult,
} from "./types.js";

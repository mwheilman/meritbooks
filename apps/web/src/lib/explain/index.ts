/** "Explain this ___" — public surface. */
export {
  gatherExplanation,
  deterministicExplainNarrative,
  buildExplainFacts,
  EXPLAIN_SYSTEM,
  ExplainNotFoundError,
} from './assemble';
export type {
  ExplainKind,
  Explanation,
  ExplainResult,
  ExplainFact,
  ExplainLink,
  ExplainLineFact,
  ExplainActor,
} from './types';
export { EXPLAIN_KINDS } from './types';

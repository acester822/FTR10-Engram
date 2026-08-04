/*
 - filename
 - what is the file used for
*/

export const DURABLE_RECALL_SCORE_WEIGHTS = {
  semantic: 0.4,
  confidence: 0.25,
  salience: 0.15,
  provenance: 0.2,
  lexical: 0.1,
  contradiction_penalty: 0.35,
  contract_penalty: 1,
} as const;

export interface DurableRecallScoreInput {
  confidence?: number;
  salience?: number;
  provenance_count?: number;
  contradiction_count?: number;
  recall_allowed?: boolean;
  vector_distance?: number | null;
  text_match?: boolean;
  lexical_score?: number;
}

export interface DurableRecallScore {
  confidence: number;
  salience: number;
  provenance: number;
  semantic: number;
  lexical: number;
  contradiction_penalty: number;
  contract_penalty: number;
  score: number;
}

const clamp01 = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0;

export function scoreDurableRecall(
  input: DurableRecallScoreInput,
): DurableRecallScore {
  const confidence = clamp01(input.confidence ?? 0);
  const salience = clamp01(input.salience ?? 0);
  const provenance =
    input.provenance_count && input.provenance_count > 0 ? 1 : 0;
  const lexical = clamp01(input.lexical_score ?? 0);
  const semantic =
    input.vector_distance === undefined || input.vector_distance === null
      ? input.text_match === false
        ? 0
        : 1
      : clamp01(1 - input.vector_distance);
  const contradiction_penalty =
    input.contradiction_count && input.contradiction_count > 0
      ? DURABLE_RECALL_SCORE_WEIGHTS.contradiction_penalty
      : 0;
  const contract_penalty =
    input.recall_allowed === false
      ? DURABLE_RECALL_SCORE_WEIGHTS.contract_penalty
      : 0;
  const weighted =
    semantic * DURABLE_RECALL_SCORE_WEIGHTS.semantic +
    confidence * DURABLE_RECALL_SCORE_WEIGHTS.confidence +
    salience * DURABLE_RECALL_SCORE_WEIGHTS.salience +
    provenance * DURABLE_RECALL_SCORE_WEIGHTS.provenance +
    lexical * DURABLE_RECALL_SCORE_WEIGHTS.lexical -
    contradiction_penalty -
    contract_penalty;

  return {
    confidence,
    salience,
    provenance,
    semantic,
    lexical,
    contradiction_penalty,
    contract_penalty,
    score: clamp01(weighted),
  };
}

// ── Evidence fusion (hybrid search) ──────────────────────────────────────
// P(relevant) = 1 - (1 - p_vec)(1 - p_lex): either signal alone suffices,
// both together compound. Scores are probabilities in [0, 1].

/**
 * Convert a raw cosine similarity (1 - distance) into a vector probability.
 * The doc's calibration: map [0.25, 0.85] onto [0, 0.88], saturating at 0.88.
 */
export function vectorProbability(vectorScore: number): number {
  if (!Number.isFinite(vectorScore)) return 0;
  return Math.max(0, Math.min((vectorScore - 0.25) / 0.6, 0.88));
}

/** Convert a lexical score into a lexical probability, capped at 0.95. */
export function lexicalProbability(lexicalScore: number): number {
  if (!Number.isFinite(lexicalScore)) return 0;
  return Math.min(Math.max(lexicalScore, 0) * 2, 0.95);
}

/** Evidence fusion of vector and lexical probabilities. */
export function fuseEvidence(vectorScore: number, lexicalScore: number): number {
  const pVec = vectorProbability(vectorScore);
  const pLex = lexicalProbability(lexicalScore);
  return 1 - (1 - pVec) * (1 - pLex);
}

/**
 * Importance multiplier on top of the fused score.
 * Neutral (1.0) at the default importance_score of 0.5; ranges [0.85, 1.15].
 */
export function importanceMultiplier(importanceScore: number): number {
  const s = clamp01(importanceScore);
  return 1 + 0.15 * (2 * s - 1);
}

/**
 * Hybrid recall score: fused vector+lexical evidence scaled by importance,
 * minus the same contradiction/contract penalties the weighted scorer applies.
 */
export function hybridRecallScore(input: {
  vectorDistance: number | null;
  lexicalScore: number;
  importanceScore: number;
  contradictionPenalty?: number;
  contractPenalty?: number;
}): number {
  const pFused =
    input.vectorDistance == null
      ? fuseEvidence(0, input.lexicalScore)
      : fuseEvidence(1 - input.vectorDistance, input.lexicalScore);
  const penalty = (input.contradictionPenalty ?? 0) + (input.contractPenalty ?? 0);
  return clamp01(pFused * importanceMultiplier(input.importanceScore) - penalty);
}

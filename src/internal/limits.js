/**
 * Tuning knobs: per-flow output token caps and iteration limits.
 *
 * TOOL_OUTPUT_TOKENS / TOOL_LOOP_ITERATIONS apply per iteration of the agentic
 * tool loop (toolLoop.js). DIRECT_LLM_OUTPUT_TOKENS is for one-shot LLM calls
 * outside the loop. Algorithm constants stay near their algorithms.
 */

export const TOOL_OUTPUT_TOKENS = {
    // Headroom for reasoning + synthesized prose in assemble_context.
    retrieval: 8000,
    retrievalAugment: 8000,
    // Structured write calls; short args, multiple per turn.
    ingestion: 4000,
    // Tiny structured calls (delete_bullet).
    deletion: 2000
};

export const TOOL_LOOP_ITERATIONS = {
    retrieval: 10,
    retrievalAugment: 12,
    ingestion: 12,
    deletion: 8,
    // Deep delete visits every file; budget is max(this, paths.length * 3).
    deletionDeepFloor: 30
};

export const DIRECT_LLM_OUTPUT_TOKENS = {
    // 1-2 sentence direct answer for already-covered queries.
    retrievalDirectAnswer: 250,
    // Numbered KEEP/SUPERSEDED lines for hundreds of bullets.
    compactionSemanticReview: 6000,
    // Single memory file rewrite.
    compactionRewrite: 1800
};

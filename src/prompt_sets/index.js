/**
 * Prompt set registry.
 *
 * Each mode provides an ingestionPrompt (and optionally others in future).
 * resolvePromptSet(mode) returns the full prompt set, falling back to 'conversation'.
 *
 * Adding a new mode: create src/prompt_sets/<mode>/ingestion.js, export ingestionPrompt,
 * then add it to PROMPT_SETS below.
 */

import { ingestionPrompt as conversationIngestion } from './conversation/ingestion.js';
import { ingestionPrompt as documentIngestion } from './document/ingestion.js';

/** @type {Record<string, { ingestionPrompt: string }>} */
const PROMPT_SETS = {
    conversation: { ingestionPrompt: conversationIngestion },
    document:     { ingestionPrompt: documentIngestion },
};

/**
 * Resolve the prompt set for a given mode.
 * Falls back to 'conversation' for unknown modes.
 *
 * @param {string} [mode]
 * @returns {{ ingestionPrompt: string }}
 */
export function resolvePromptSet(mode = 'conversation') {
    return PROMPT_SETS[mode] || PROMPT_SETS.conversation;
}

export const AVAILABLE_MODES = Object.keys(PROMPT_SETS);

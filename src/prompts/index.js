/**
 * Prompt registry for nanomem.
 *
 * Each mode provides an ingestionPrompt (and optionally others in future).
 * resolvePromptSet(mode) returns the full prompt set, falling back to 'conversation'.
 *
 * Adding a new mode: create the prompt in src/prompts/ingestion/<mode>.js or
 * src/prompts/deletion/<mode>.js, then add it to PROMPT_SETS below.
 */

import { ingestionPrompt as conversationIngestion, addPrompt, updatePrompt } from './ingestion/conversation.js';
import { ingestionPrompt as documentIngestion, addPrompt as documentAddPrompt, updatePrompt as documentUpdatePrompt } from './ingestion/document.js';
import { deletePrompt, deepDeletePrompt } from './deletion/conversation.js';
import { deletePrompt as documentDeletePrompt, deepDeletePrompt as documentDeepDeletePrompt } from './deletion/document.js';
import { retrievalPrompt, augmentAddendum, augmentCrafterPrompt } from './retrieval.js';

/** @type {Record<string, { ingestionPrompt: string }>} */
const PROMPT_SETS = {
    conversation:    { ingestionPrompt: conversationIngestion },
    document:        { ingestionPrompt: documentIngestion },
    add:             { ingestionPrompt: addPrompt },
    update:          { ingestionPrompt: updatePrompt },
    document_add:    { ingestionPrompt: documentAddPrompt },
    document_update: { ingestionPrompt: documentUpdatePrompt },
    delete:          { ingestionPrompt: deletePrompt },
    deep_delete:     { ingestionPrompt: deepDeletePrompt },
    document_delete:      { ingestionPrompt: documentDeletePrompt },
    document_deep_delete: { ingestionPrompt: documentDeepDeletePrompt },
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

export { retrievalPrompt, augmentAddendum, augmentCrafterPrompt };

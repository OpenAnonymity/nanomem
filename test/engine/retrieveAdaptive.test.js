import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRetriever } from '../../src/tools/retrieval.js';

function createRetriever({ searchResults = [], llmClient = null } = {}) {
    const backend = {
        async init() {},
        async getTree() {
            return 'work/projects.md';
        },
        async exportAll() {
            return [{ path: 'work/projects.md', itemCount: 1 }];
        },
        async search() {
            return searchResults;
        },
        async read() {
            return null;
        }
    };

    const bulletIndex = {
        async init() {},
        getBulletsForPaths() {
            return [];
        },
        async refreshPath() {}
    };

    const resolvedLlmClient = llmClient || {
        async createChatCompletion() {
            throw new Error('simulated adaptive failure');
        }
    };

    return new MemoryRetriever({
        backend,
        bulletIndex,
        llmClient: resolvedLlmClient,
        model: 'test-model'
    });
}

describe('retrieveAdaptively', () => {
    it('returns a skipped result instead of null when adaptive retrieval fallback finds nothing', async () => {
        const retriever = createRetriever();

        const result = await retriever.retrieveAdaptively(
            'what deadlines do those projects have?',
            '**NomNom** has a June 15 launch deadline. **Mise** is in early alpha.',
            null
        );

        assert.deepEqual(result, {
            files: [],
            paths: [],
            assembledContext: null,
            skipped: true,
            skipReason: 'No new relevant memory found.'
        });
    });

    it('expands referential fallback queries with salient entities from prior retrieved context', () => {
        const retriever = createRetriever();

        const query = retriever._buildAdaptiveFallbackQuery(
            'what deadlines do those projects have?',
            'You have two projects: **NomNom** and **Mise**.'
        );

        assert.match(query, /\bNomNom\b/);
        assert.match(query, /\bMise\b/);
    });

    it('detects newly assembled context that duplicates prior retrieved context', () => {
        const retriever = createRetriever();

        assert.equal(
            retriever._isContextRedundant(
                'The user follows a gluten-free diet and prefers warm savory meat-forward East Asian options.',
                'Follows a gluten-free diet. Prefers warm, savory, meat-forward, and East Asian inspired options.'
            ),
            true
        );
    });

    it('returns a skipped adaptive augment result when prior context is sufficient', async () => {
        const retriever = createRetriever();

        const result = await retriever.augmentQueryAdaptively(
            'what about more spicy foods?',
            'Follows a gluten-free diet. Prefers warm, savory, meat-forward, and East Asian inspired options.',
            null
        );

        assert.equal(result.skipped, true);
        assert.equal(result.reviewPrompt, null);
        assert.equal(result.apiPrompt, null);
    });

    it('crafts adaptive augment prompts from only newly retrieved context', async () => {
        const calls = [];
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion(request) {
                    calls.push(request);
                    if (calls.length === 1) {
                        return {
                            content: '',
                            tool_calls: [{
                                id: 'call-1',
                                type: 'function',
                                function: {
                                    name: 'assemble_context',
                                    arguments: JSON.stringify({
                                        content: 'You have a severe peanut allergy.'
                                    })
                                }
                            }]
                        };
                    }

                    return {
                        content: JSON.stringify({
                            reviewPrompt: 'Avoid restaurants where cross-contact is likely. [[user_data]]The user has a severe peanut allergy.[[/user_data]]'
                        }),
                        tool_calls: []
                    };
                }
            }
        });

        const result = await retriever.augmentQueryAdaptively(
            'any spicy thai recs?',
            'Follows a gluten-free diet.',
            'User: any spicy thai recs?'
        );

        assert.equal(result.skipped, false);
        assert.equal(result.assembledContext, 'You have a severe peanut allergy.');
        assert.match(result.reviewPrompt, /severe peanut allergy/);
        assert.equal(
            result.apiPrompt,
            'Avoid restaurants where cross-contact is likely. The user has a severe peanut allergy.'
        );
        assert.doesNotMatch(calls[1].messages[1].content, /gluten-free diet/);
    });
});

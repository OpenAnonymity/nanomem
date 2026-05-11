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

        assert.equal(result.skipped, true);
        assert.equal(result.skipReason, 'No new relevant memory found.');
        assert.equal(result.retrievalConfidence, 'low');
        assert.equal(result.coverage, 'none');
        assert.deepEqual(result.missingVariables, []);
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

    it('returns retrieval confidence metadata from normal retrieval', async () => {
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion() {
                    return {
                        content: '',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: {
                                name: 'assemble_context',
                                arguments: JSON.stringify({
                                    content: 'NomNom has a June 15 launch deadline.',
                                    retrieval_confidence: 'high',
                                    coverage: 'full',
                                    missing_variables: [],
                                    confidence_reason: 'The retrieved memory directly answers the deadline question.'
                                })
                            }
                        }]
                    };
                }
            }
        });

        const result = await retriever.retrieveForQuery('what is the NomNom deadline?');

        assert.equal(result.assembledContext, 'NomNom has a June 15 launch deadline.');
        assert.equal(result.retrievalConfidence, 'high');
        assert.equal(result.coverage, 'full');
        assert.deepEqual(result.missingVariables, []);
        assert.equal(result.retrievalReason, 'The retrieved memory directly answers the deadline question.');
    });

    it('normalizes missing retrieval confidence metadata conservatively', () => {
        const retriever = createRetriever();

        assert.deepEqual(
            retriever._normalizeRetrievalAssessment(null, {
                hasContent: false,
                skipped: false,
                hasPriorContext: false
            }),
            {
                retrievalConfidence: 'low',
                coverage: 'none',
                missingVariables: [],
                retrievalReason: null,
                factConfidence: null,
                uncertainFacts: []
            }
        );

        assert.deepEqual(
            retriever._normalizeRetrievalAssessment({
                retrieval_confidence: 'high',
                coverage: 'partial',
                missing_variables: ['current location'],
                confidence_reason: 'Location is still missing.'
            }, {
                hasContent: true,
                skipped: false,
                hasPriorContext: true
            }),
            {
                retrievalConfidence: 'medium',
                coverage: 'partial',
                missingVariables: ['current location'],
                retrievalReason: 'Location is still missing.',
                factConfidence: null,
                uncertainFacts: []
            }
        );
    });

    it('keeps a model-assembled adaptive result even when it overlaps prior context', async () => {
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion() {
                    return {
                        content: '',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: {
                                name: 'assemble_context',
                                arguments: JSON.stringify({
                                    content: 'Follows a gluten-free diet and has a severe peanut allergy.',
                                    retrieval_confidence: 'high',
                                    coverage: 'full',
                                    missing_variables: [],
                                    confidence_reason: 'The new allergy detail completes the restaurant constraints.'
                                })
                            }
                        }]
                    };
                }
            }
        });

        const result = await retriever.retrieveAdaptively(
            'any spicy thai recs?',
            'Follows a gluten-free diet.',
            'User: any spicy thai recs?'
        );

        assert.equal(result.skipped, false);
        assert.equal(result.assembledContext, 'Follows a gluten-free diet and has a severe peanut allergy.');
        assert.equal(result.retrievalConfidence, 'high');
        assert.equal(result.coverage, 'full');
    });

    it('does not preserve high confidence for partial adaptive skips', async () => {
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion(request) {
                    if (request.tools) {
                        return {
                            content: '',
                            tool_calls: [{
                                id: 'call-1',
                                type: 'function',
                                function: {
                                    name: 'assemble_context',
                                    arguments: JSON.stringify({
                                        content: '',
                                        skipped: true,
                                        skip_reason: 'Existing context is related but incomplete.',
                                        retrieval_confidence: 'high',
                                        coverage: 'partial',
                                        missing_variables: ['current budget'],
                                        confidence_reason: 'Budget is still missing.'
                                    })
                                }
                            }]
                        };
                    }

                    return { content: '', tool_calls: [] };
                }
            }
        });

        const result = await retriever.retrieveAdaptively(
            'is this worth it?',
            'You are considering a conference in Seattle.',
            null
        );

        assert.equal(result.skipped, true);
        assert.equal(result.retrievalConfidence, 'medium');
        assert.equal(result.coverage, 'partial');
        assert.deepEqual(result.missingVariables, ['current budget']);
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

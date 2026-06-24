import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRetriever } from '../../src/tools/retrieval.js';

function createRetriever({ searchResults = [], readContent = null, bulletIndex = null, llmClient = null } = {}) {
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
        async read(path) {
            if (readContent && typeof readContent === 'object') {
                return readContent[path] || null;
            }
            return readContent;
        }
    };

    const resolvedBulletIndex = bulletIndex || {
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
        bulletIndex: resolvedBulletIndex,
        llmClient: resolvedLlmClient,
        model: 'test-model'
    });
}

function assertConfidenceScore(value) {
    assert.equal(typeof value, 'number');
    assert.ok(value >= 0 && value <= 1);
}

describe('retrieveAdaptively', () => {
    it('returns normalized no-memory metadata when first-turn adaptive retrieval finds nothing', async () => {
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
                                        retrieval_confidence: 0,
                                        coverage: 'none',
                                        missing_variables: ['dietary preferences'],
                                        confidence_reason: 'No relevant personal memory was found.'
                                    })
                                }
                            }]
                        };
                    }

                    return { content: '', tool_calls: [] };
                }
            }
        });

        const result = await retriever.retrieveAdaptively('Any dinner ideas for tonight?');

        assert.equal(result.skipped, true);
        assert.equal(result.skipReason, 'No new relevant memory found.');
        assert.equal(result.coverage, 'none');
        assert.equal(result.retrievalConfidence, 0);
        assert.deepEqual(result.missingVariables, ['dietary preferences']);
        assert.equal(result.retrievalReason, 'No relevant personal memory was found.');
    });

    it('returns a skipped result instead of null when adaptive retrieval fallback finds nothing', async () => {
        const retriever = createRetriever();

        const result = await retriever.retrieveAdaptively(
            'what deadlines do those projects have?',
            '**NomNom** has a June 15 launch deadline. **Mise** is in early alpha.',
            null
        );

        assert.equal(result.skipped, true);
        assert.equal(result.skipReason, 'No new relevant memory found.');
        assert.equal(result.retrievalConfidence, 0);
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

    it('skips adaptive retrieval when the no-op precheck is high confidence', async () => {
        const calls = [];
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion(request) {
                    calls.push(request);
                    assert.equal(request.tools, undefined);
                    if (calls.length === 1) {
                        return {
                            content: 'skip | high | The deadline is already present in the retrieved context.',
                            tool_calls: []
                        };
                    }
                    return { content: 'NomNom has a June 15 launch deadline.', tool_calls: [] };
                }
            }
        });

        const result = await retriever.retrieveAdaptively(
            'what was that deadline again?',
            '**NomNom** has a June 15 launch deadline.',
            null
        );

        assert.equal(result.skipped, true);
        assert.equal(result.skipReason, 'Already covered by retrieved context.');
        assert.equal(result.coverage, 'full');
        assert.equal(result.retrievalConfidence, null);
        assert.equal(result.retrievalReason, 'The deadline is already present in the retrieved context.');
        assert.equal(result.displayText, 'NomNom has a June 15 launch deadline.');
        assert.equal(calls.length, 2);
    });

    it('retrieves when the no-op precheck is not high confidence', async () => {
        const calls = [];
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion(request) {
                    calls.push(request);
                    if (!request.tools) {
                        return {
                            content: 'skip | medium | The prior context may answer part of the query.',
                            tool_calls: []
                        };
                    }

                    return {
                        content: '',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: {
                                name: 'assemble_context',
                                arguments: JSON.stringify({
                                    content: 'Mise is in early alpha.',
                                    retrieval_confidence: 0.62,
                                    coverage: 'partial',
                                    missing_variables: [],
                                    confidence_reason: 'The retrieved context adds a project status.'
                                })
                            }
                        }]
                    };
                }
            }
        });

        const result = await retriever.retrieveAdaptively(
            'what else do I know about those projects?',
            '**NomNom** has a June 15 launch deadline.',
            null
        );

        assert.equal(result.skipped, false);
        assert.equal(result.assembledContext, 'Mise is in early alpha.');
        assert.equal(result.coverage, 'partial');
        assert.equal(calls.some((request) => Boolean(request.tools)), true);
    });

    it('continues adaptive retrieval when the no-op precheck fails', async () => {
        let calls = 0;
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion(request) {
                    calls += 1;
                    if (!request.tools) {
                        throw new Error('precheck unavailable');
                    }

                    return {
                        content: '',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: {
                                name: 'assemble_context',
                                arguments: JSON.stringify({
                                    content: 'Mise is in early alpha.',
                                    retrieval_confidence: 0.62,
                                    coverage: 'partial',
                                    confidence_reason: 'The retrieved context adds a project status.'
                                })
                            }
                        }]
                    };
                }
            }
        });

        const result = await retriever.retrieveAdaptively(
            'what else do I know about those projects?',
            '**NomNom** has a June 15 launch deadline.',
            null
        );

        assert.equal(result.skipped, false);
        assert.equal(result.assembledContext, 'Mise is in early alpha.');
        assert.equal(calls, 2);
    });

    it('uses keyword fallback when the model tries to skip with incomplete coverage before retrieving', async () => {
        const retriever = createRetriever({
            searchResults: [{ path: 'work/projects.md' }],
            readContent: {
                'work/projects.md': [
                    '# Projects',
                    '',
                    '## Long-Term',
                    '- Mise is in early alpha. | tier=long_term | status=active | source=user_statement | confidence=1'
                ].join('\n')
            },
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
                                        retrieval_confidence: 0.58,
                                        coverage: 'partial',
                                        missing_variables: ['other project statuses'],
                                        confidence_reason: 'Other projects may be missing.'
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
            'what else do I know about those projects?',
            '**NomNom** has a June 15 launch deadline.',
            null
        );

        assert.equal(result.skipped, false);
        assert.match(result.assembledContext, /Mise is in early alpha/);
        assert.equal(result.coverage, 'partial');
        assert.equal(result.retrievalConfidence, null);
    });

    it('preserves skipped metadata when retrieval was attempted but found nothing new', async () => {
        let toolCalls = 0;
        const retriever = createRetriever({
            searchResults: [{ path: 'work/projects.md' }],
            llmClient: {
                async createChatCompletion(request) {
                    if (!request.tools) {
                        return {
                            content: 'retrieve | high | Check for missing project details.',
                            tool_calls: []
                        };
                    }

                    toolCalls += 1;
                    if (toolCalls === 1) {
                        return {
                            content: '',
                            tool_calls: [{
                                id: 'call-search',
                                type: 'function',
                                function: {
                                    name: 'search_memory',
                                    arguments: JSON.stringify({ query: 'Mise' })
                                }
                            }]
                        };
                    }

                    return {
                        content: '',
                        tool_calls: [{
                            id: 'call-assemble',
                            type: 'function',
                            function: {
                                name: 'assemble_context',
                                arguments: JSON.stringify({
                                    content: '',
                                    skipped: true,
                                    skip_reason: 'No new relevant memory found.',
                                    retrieval_confidence: 0.42,
                                    coverage: 'partial',
                                    missing_variables: ['project owner'],
                                    confidence_reason: 'Prior context is useful, but owner was not found.'
                                })
                            }
                        }]
                    };
                }
            }
        });

        const result = await retriever.retrieveAdaptively(
            'who owns those projects?',
            '**NomNom** has a June 15 launch deadline. **Mise** is in early alpha.',
            null
        );

        assert.equal(result.skipped, true);
        assert.equal(result.skipReason, 'No new relevant memory found.');
        assert.equal(result.coverage, 'partial');
        assert.equal(result.retrievalConfidence, 0.42);
        assert.deepEqual(result.missingVariables, ['project owner']);
        assert.equal(result.retrievalReason, 'Prior context is useful, but owner was not found.');
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

    it('suppresses model-assembled context that duplicates prior retrieved context', async () => {
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion(request) {
                    if (!request.tools) {
                        return {
                            content: 'retrieve | high | Check whether there is anything new.',
                            tool_calls: []
                        };
                    }

                    return {
                        content: '',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: {
                                name: 'assemble_context',
                                arguments: JSON.stringify({
                                    content: 'Follows a gluten-free diet and prefers warm savory meat-forward East Asian options.',
                                    retrieval_confidence: 0.88,
                                    coverage: 'full',
                                    missing_variables: [],
                                    confidence_reason: 'The retrieved context answers the food preference query.'
                                })
                            }
                        }]
                    };
                }
            }
        });

        const result = await retriever.retrieveAdaptively(
            'what food preferences should I use?',
            'Follows a gluten-free diet. Prefers warm, savory, meat-forward, and East Asian inspired options.',
            null
        );

        assert.equal(result.skipped, true);
        assert.equal(result.skipReason, 'Already covered by retrieved context.');
        assert.equal(result.coverage, 'full');
        assertConfidenceScore(result.retrievalConfidence);
    });

    it('suppresses retrieved context when the model assesses coverage as none', async () => {
        const retriever = createRetriever({
            llmClient: {
                async createChatCompletion(request) {
                    if (!request.tools) {
                        return {
                            content: 'retrieve | high | The query may need new memory.',
                            tool_calls: []
                        };
                    }

                    return {
                        content: '',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: {
                                name: 'assemble_context',
                                arguments: JSON.stringify({
                                    content: 'The user once mentioned a loosely related project.',
                                    retrieval_confidence: 0.83,
                                    coverage: 'none',
                                    missing_variables: [],
                                    confidence_reason: 'The retrieved memory does not help answer the query.'
                                })
                            }
                        }]
                    };
                }
            }
        });

        const result = await retriever.retrieveAdaptively(
            'what should I book?',
            'User is considering a conference in Seattle.',
            null
        );

        assert.equal(result.skipped, true);
        assert.equal(result.skipReason, 'No new relevant memory found.');
        assert.equal(result.coverage, 'none');
        assert.equal(result.retrievalConfidence, 0);
        assert.equal(result.assembledContext, null);
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
                                    retrieval_confidence: 0.91,
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
        assertConfidenceScore(result.retrievalConfidence);
        assert.equal(result.coverage, 'full');
        assert.deepEqual(result.missingVariables, []);
        assert.equal(result.retrievalReason, 'The retrieved memory directly answers the deadline question.');
    });

    it('normalizes numeric retrieval confidence metadata conservatively', () => {
        const retriever = createRetriever();

        assert.deepEqual(
            retriever._normalizeRetrievalAssessment(null, {
                hasContent: false,
                skipped: false,
                hasPriorContext: false
            }),
            {
                retrievalConfidence: 0,
                coverage: 'none',
                missingVariables: [],
                retrievalReason: null,
                uncertainFacts: []
            }
        );

        assert.deepEqual(
            retriever._normalizeRetrievalAssessment({
                retrieval_confidence: '1.2',
                coverage: 'partial',
                missing_variables: ['current location'],
                confidence_reason: 'Location is still missing.'
            }, {
                hasContent: true,
                skipped: false,
                hasPriorContext: true
            }),
            {
                retrievalConfidence: 1,
                coverage: 'partial',
                missingVariables: ['current location'],
                retrievalReason: 'Location is still missing.',
                uncertainFacts: []
            }
        );

        assert.deepEqual(
            retriever._normalizeRetrievalAssessment({
                coverage: 'full',
                missing_variables: [],
                confidence_reason: 'Existing context answers the query.'
            }, {
                hasContent: false,
                skipped: true,
                hasPriorContext: true
            }),
            {
                retrievalConfidence: null,
                coverage: 'full',
                missingVariables: [],
                retrievalReason: 'Existing context answers the query.',
                uncertainFacts: []
            }
        );

        assert.deepEqual(
            retriever._normalizeRetrievalAssessment({
                coverage: 'full',
                missing_variables: [],
                confidence_reason: 'Confidence omitted by model.'
            }, {
                hasContent: true,
                skipped: false,
                hasPriorContext: false
            }),
            {
                retrievalConfidence: null,
                coverage: 'full',
                missingVariables: [],
                retrievalReason: 'Confidence omitted by model.',
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
                                    retrieval_confidence: 0.84,
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
        assertConfidenceScore(result.retrievalConfidence);
        assert.equal(result.coverage, 'full');
    });

    it('does not accept partial adaptive skips without a retrieval attempt', async () => {
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
                                        retrieval_confidence: 0.87,
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
        assert.equal(result.skipReason, 'No new relevant memory found.');
        assert.equal(result.retrievalConfidence, 0);
        assert.equal(result.coverage, 'none');
        assert.deepEqual(result.missingVariables, []);
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
                    if (!request.tools) {
                        if (calls.length === 1) {
                            return {
                                content: 'retrieve | high | The recommendation may need additional personal constraints.',
                                tool_calls: []
                            };
                        }

                        return {
                            content: JSON.stringify({
                                reviewPrompt: 'Avoid restaurants where cross-contact is likely. [[user_data]]The user has a severe peanut allergy.[[/user_data]]'
                            }),
                            tool_calls: []
                        };
                    }

                    if (request.tools) {
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
        assert.doesNotMatch(calls[2].messages[1].content, /gluten-free diet/);
    });
});

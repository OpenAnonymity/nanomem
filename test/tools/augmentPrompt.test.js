import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { craftAugmentedPromptFromFiles } from '../../src/tools/executors.js';

describe('craftAugmentedPromptFromFiles', () => {
    it('instructs the prompt crafter to preserve first-person query voice', async () => {
        const calls = [];
        const llmClient = {
            async createChatCompletion(request) {
                calls.push(request);
                return {
                    content: JSON.stringify({
                        reviewPrompt: 'I want recs for snowboards. [[user_data]]I experience foot pain in stiff boots.[[/user_data]]'
                    }),
                    tool_calls: []
                };
            }
        };

        const result = await craftAugmentedPromptFromFiles({
            llmClient,
            model: 'test-model',
            query: 'I want recs for snowboards',
            files: [{
                path: 'sports/snowboarding.md',
                content: '- The user experiences foot pain in stiff boots.'
            }]
        });

        assert.equal(result.reviewPrompt, 'I want recs for snowboards. [[user_data]]I experience foot pain in stiff boots.[[/user_data]]');
        assert.equal(result.apiPrompt, 'I want recs for snowboards. I experience foot pain in stiff boots.');

        const systemPrompt = calls[0].messages[0].content;
        const userPrompt = calls[0].messages[1].content;
        assert.match(systemPrompt, /Preserve the user's grammatical perspective/);
        assert.match(systemPrompt, /write the final prompt in first person/);
        assert.match(systemPrompt, /Prefer "\[\[user_data\]\]I experience\.\.\.\[\[\/user_data\]\]"/);
        assert.match(userPrompt, /for first-person requests, added memory facts should also be first-person/);
    });
});

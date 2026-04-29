/**
 * Live provider tests for the OpenAI-compatible client.
 *
 * These tests hit real APIs to catch provider-contract regressions
 * (e.g. a model rejecting `max_completion_tokens`). They auto-skip
 * when the relevant API key env var is not set, so they're a no-op
 * in CI and for contributors without keys.
 *
 * Run locally:
 *   OPENAI_API_KEY=sk-... npm test
 *   OPENROUTER_API_KEY=sk-or-... npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIClient } from '../../src/internal/llm-client/openai.js';

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

const PROMPT = [{ role: 'user', content: 'Reply with just: ok' }];

describe('OpenAIClient', () => {
    it('OpenAI accepts max_completion_tokens for gpt-5-nano', { skip: !OPENAI_KEY, timeout: 30_000 }, async () => {
        const client = createOpenAIClient({ apiKey: OPENAI_KEY });
        const res = await client.createChatCompletion({
            model: 'gpt-5.4-nano',
            messages: PROMPT,
            max_tokens: 32,
        });
        assert.equal(typeof res.content, 'string');
    });

    it('OpenAI streaming accepts max_completion_tokens for gpt-5-nano', { skip: !OPENAI_KEY, timeout: 30_000 }, async () => {
        const client = createOpenAIClient({ apiKey: OPENAI_KEY });
        const deltas = [];
        const res = await client.streamChatCompletion({
            model: 'gpt-5.4-nano',
            messages: PROMPT,
            max_tokens: 32,
            onDelta: (d) => deltas.push(d),
        });
        assert.equal(typeof res.content, 'string');
        assert.ok(res.content.length > 0, 'expected non-empty streamed content');
    });

    it('OpenRouter accepts max_completion_tokens for openai/gpt-4o', { skip: !OPENROUTER_KEY, timeout: 30_000 }, async () => {
        const client = createOpenAIClient({
            apiKey: OPENROUTER_KEY,
            baseUrl: 'https://openrouter.ai/api/v1',
        });
        const res = await client.createChatCompletion({
            model: 'openai/gpt-4o',
            messages: PROMPT,
            max_tokens: 32,
        });
        assert.equal(typeof res.content, 'string');
    });
});

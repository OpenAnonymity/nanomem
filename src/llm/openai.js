/**
 * OpenAI-compatible HTTP client.
 *
 * Works with OpenAI, Tinfoil, OpenRouter, or any provider
 * that implements the OpenAI Chat Completions API format.
 *
 * Uses `fetch` (built into Node 18+ and browsers).
 */
/** @import { ChatCompletionParams, ChatCompletionResponse, LLMClient, LLMClientOptions, ToolCall } from '../types.js' */

/**
 * @param {LLMClientOptions} [options]
 * @returns {LLMClient}
 */
export function createOpenAIClient({ apiKey, baseUrl = 'https://api.openai.com/v1', headers = {} } = /** @type {LLMClientOptions} */ ({ apiKey: '' })) {
    // Normalize: strip trailing slash
    const base = baseUrl.replace(/\/+$/, '');

    function buildHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...headers,
        };
    }

    async function createChatCompletion({ model, messages, tools, max_tokens, temperature }) {
        const body = { model, messages, temperature };
        if (max_tokens != null) body.max_tokens = max_tokens;
        if (tools && tools.length > 0) body.tools = tools;

        const response = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`OpenAI API error ${response.status}: ${text}`);
        }

        const data = await response.json();
        const choice = data.choices?.[0]?.message || {};

        return {
            content: choice.content || '',
            tool_calls: (choice.tool_calls || []).map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '{}',
                },
            })),
            usage: data.usage || null,
        };
    }

    async function streamChatCompletion({ model, messages, tools, max_tokens, temperature, onDelta, onReasoning }) {
        const body = { model, messages, temperature, stream: true };
        if (max_tokens != null) body.max_tokens = max_tokens;
        if (tools && tools.length > 0) body.tools = tools;

        const response = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`OpenAI API error ${response.status}: ${text}`);
        }

        // Accumulate the full response from SSE deltas
        let content = '';
        const toolCallAccumulator = new Map();

        await readSSE(response, (chunk) => {
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) return;

            // Content delta
            if (delta.content) {
                content += delta.content;
                onDelta?.(delta.content);
            }

            // Reasoning delta (some providers send this)
            if (delta.reasoning) {
                onReasoning?.(delta.reasoning);
            }

            // Tool call deltas — accumulate by index
            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallAccumulator.has(idx)) {
                        toolCallAccumulator.set(idx, {
                            id: tc.id || '',
                            type: 'function',
                            function: { name: '', arguments: '' },
                        });
                    }
                    const acc = toolCallAccumulator.get(idx);
                    if (!acc) continue;
                    if (tc.id) acc.id = tc.id;
                    if (tc.function?.name) acc.function.name += tc.function.name;
                    if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                }
            }
        });

        const tool_calls = [...toolCallAccumulator.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => tc);

        return {
            content,
            tool_calls,
            usage: null,
        };
    }

    return { createChatCompletion, streamChatCompletion };
}

// ─── SSE Parser ──────────────────────────────────────────────

async function readSSE(response, onMessage) {
    if (!response.body) {
        throw new Error('Streaming response body is not available.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith(':')) continue;
            if (!trimmed.startsWith('data:')) continue;

            const data = trimmed.replace(/^data:\s*/, '');
            if (!data || data === '[DONE]') {
                if (data === '[DONE]') return;
                continue;
            }

            try {
                const parsed = JSON.parse(data);
                onMessage(parsed);
            } catch {
                // Skip unparseable SSE lines
            }
        }
    }

    const remaining = buffer.trim();
    if (remaining && remaining.startsWith('data:')) {
        const data = remaining.replace(/^data:\s*/, '');
        if (data && data !== '[DONE]') {
            try {
                const parsed = JSON.parse(data);
                onMessage(parsed);
            } catch {
                // Skip
            }
        }
    }
}

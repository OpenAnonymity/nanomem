/**
 * Anthropic Messages API client.
 *
 * Translates the standard LLM client interface (OpenAI Chat Completions format)
 * into Anthropic's Messages API format, so the memory system can use Claude models.
 *
 * Uses `fetch` (built into Node 18+ and browsers).
 */
/** @import { ChatCompletionParams, ChatCompletionResponse, LLMClient, LLMClientOptions, LLMMessage, ToolCall, ToolDefinition } from '../types.js' */

/**
 * @param {LLMClientOptions} [options]
 * @returns {LLMClient}
 */
export function createAnthropicClient({ apiKey, baseUrl = 'https://api.anthropic.com', headers = {} } = /** @type {LLMClientOptions} */ ({ apiKey: '' })) {
    const base = baseUrl.replace(/\/+$/, '');

    function buildHeaders() {
        return {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            ...headers,
        };
    }

    function convertMessages(messages) {
        let system = '';
        const converted = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                system += (system ? '\n\n' : '') + msg.content;
                continue;
            }

            if (msg.role === 'tool') {
                // Anthropic uses tool_result content blocks inside "user" messages
                converted.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id,
                        content: msg.content,
                    }],
                });
                continue;
            }

            if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                // Build content blocks: text (if any) + tool_use blocks
                const content = [];
                if (msg.content) {
                    content.push({ type: 'text', text: msg.content });
                }
                for (const tc of msg.tool_calls) {
                    let input;
                    try {
                        input = typeof tc.function?.arguments === 'string'
                            ? JSON.parse(tc.function.arguments)
                            : (tc.function?.arguments || {});
                    } catch {
                        input = {};
                    }
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function?.name || '',
                        input,
                    });
                }
                converted.push({ role: 'assistant', content });
                continue;
            }

            // Regular user/assistant message
            converted.push({
                role: msg.role,
                content: msg.content || '',
            });
        }

        return { system, messages: converted };
    }

    function convertTools(tools) {
        if (!tools || tools.length === 0) return undefined;
        return tools.map(t => ({
            name: t.function?.name || '',
            description: t.function?.description || '',
            input_schema: t.function?.parameters || { type: 'object', properties: {} },
        }));
    }

    async function createChatCompletion({ model, messages, tools, max_tokens, temperature }) {
        const { system, messages: convertedMessages } = convertMessages(messages);
        const body = {
            model,
            messages: convertedMessages,
            max_tokens: max_tokens || 1024,
            temperature: temperature ?? 0,
        };
        if (system) body.system = system;
        const anthropicTools = convertTools(tools);
        if (anthropicTools) body.tools = anthropicTools;

        const response = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${text}`);
        }

        const data = await response.json();
        return parseAnthropicResponse(data);
    }

    async function streamChatCompletion({ model, messages, tools, max_tokens, temperature, onDelta, onReasoning }) {
        const { system, messages: convertedMessages } = convertMessages(messages);
        const body = {
            model,
            messages: convertedMessages,
            max_tokens: max_tokens || 1024,
            temperature: temperature ?? 0,
            stream: true,
        };
        if (system) body.system = system;
        const anthropicTools = convertTools(tools);
        if (anthropicTools) body.tools = anthropicTools;

        const response = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${text}`);
        }

        let content = '';
        const toolCalls = [];
        let currentToolIndex = -1;

        await readSSE(response, (event) => {
            const type = event.type;

            if (type === 'content_block_start') {
                const block = event.content_block;
                if (block?.type === 'tool_use') {
                    currentToolIndex++;
                    toolCalls.push({
                        id: block.id || '',
                        type: 'function',
                        function: { name: block.name || '', arguments: '' },
                    });
                }
            }

            if (type === 'content_block_delta') {
                const delta = event.delta;
                if (delta?.type === 'text_delta' && delta.text) {
                    content += delta.text;
                    onDelta?.(delta.text);
                }
                if (delta?.type === 'thinking_delta' && delta.thinking) {
                    onReasoning?.(delta.thinking);
                }
                if (delta?.type === 'input_json_delta' && delta.partial_json != null && currentToolIndex >= 0) {
                    toolCalls[currentToolIndex].function.arguments += delta.partial_json;
                }
            }
        });

        return {
            content,
            tool_calls: toolCalls,
            usage: null,
        };
    }

    return { createChatCompletion, streamChatCompletion };
}

// ─── Helpers ─────────────────────────────────────────────────

function parseAnthropicResponse(data) {
    let content = '';
    const toolCalls = [];

    for (const block of data.content || []) {
        if (block.type === 'text') {
            content += block.text;
        }
        if (block.type === 'tool_use') {
            toolCalls.push(/** @type {ToolCall} */ ({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {}),
                },
            }));
        }
    }

    return {
        content,
        tool_calls: toolCalls,
        usage: data.usage ? {
            prompt_tokens: data.usage.input_tokens,
            completion_tokens: data.usage.output_tokens,
        } : null,
    };
}

// ─── SSE Parser (Anthropic format) ──────────────────────────

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

        let currentEvent = null;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                currentEvent = null;
                continue;
            }
            if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.replace(/^event:\s*/, '');
                continue;
            }
            if (!trimmed.startsWith('data:')) continue;

            const data = trimmed.replace(/^data:\s*/, '');
            if (!data || data === '[DONE]') continue;

            try {
                const parsed = JSON.parse(data);
                if (currentEvent) parsed.type = parsed.type || currentEvent;
                onMessage(parsed);
            } catch {
                // Skip unparseable SSE lines
            }
        }
    }
}

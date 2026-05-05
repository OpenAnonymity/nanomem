/**
 * OpenAI-compatible HTTP client.
 *
 * Works with OpenAI, Tinfoil, OpenRouter, or any provider
 * that implements the OpenAI Chat Completions API format.
 *
 * Uses `fetch` (built into Node 20+ and browsers).
 */
/** @import { ChatCompletionParams, ChatCompletionResponse, LLMClient, LLMClientOptions, ToolCall } from '../../types.js' */
/**
 * @typedef {Error & { status?: number, retryable?: boolean, retryAfterMs?: number | null, _retryFinalized?: boolean, isUserAbort?: boolean }} ApiError
 */

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 2500;

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

    function buildRequestInit(body, signal = null) {
        return {
            method: 'POST',
            headers: buildHeaders(),
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
        };
    }

    async function createChatCompletion({ model, messages, tools, max_tokens, temperature, signal }) {
        const body = { model, messages, temperature };
        if (max_tokens != null) body.max_completion_tokens = max_tokens;
        if (tools && tools.length > 0) body.tools = tools;

        const response = await fetchWithRetry(`${base}/chat/completions`, buildRequestInit(body, signal), 'chat completion request', signal);

        const data = await response.json();
        const choice = data.choices?.[0]?.message || {};

        let tool_calls = (choice.tool_calls || []).map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '{}',
            },
        }));

        // Some models embed tool calls inside a reasoning field using a marker
        // format instead of the standard tool_calls field. Parse them as a fallback.
        if (tool_calls.length === 0) {
            const reasoningText = choice.reasoning || choice.reasoning_content || '';
            if (reasoningText) tool_calls = parseEmbeddedToolCalls(reasoningText);
        }

        return {
            content: choice.content || '',
            tool_calls,
            usage: data.usage || null,
        };
    }

    async function streamChatCompletion({ model, messages, tools, max_tokens, temperature, signal, onDelta, onReasoning }) {
        const body = { model, messages, temperature, stream: true };
        if (max_tokens != null) body.max_completion_tokens = max_tokens;
        if (tools && tools.length > 0) body.tools = tools;

        return withRetry(async (attempt) => {
            throwIfAborted(signal);
            const response = await fetch(`${base}/chat/completions`, buildRequestInit(body, signal));
            if (!response.ok) {
                throw await createHttpError(response, attempt);
            }

            // Only retry streaming requests if the connection dies before
            // any SSE data arrives. Once we have surfaced deltas, replaying
            // would duplicate partial reasoning/content.
            let content = '';
            let reasoning = '';
            let sawStreamData = false;
            const toolCallAccumulator = new Map();

            try {
                await readSSE(response, (chunk) => {
                    sawStreamData = true;

                    const delta = chunk.choices?.[0]?.delta;
                    if (!delta) return;

                    if (delta.content) {
                        content += delta.content;
                        onDelta?.(delta.content);
                    }

                    if (delta.reasoning) {
                        reasoning += delta.reasoning;
                        onReasoning?.(delta.reasoning);
                    }

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
            } catch (error) {
                if (isAbortError(error, signal)) {
                    throw markAbortError(error);
                }
                if (!sawStreamData && isRetryableNetworkError(error)) {
                    const retryError = asError(error);
                    retryError.retryable = true;
                    throw retryError;
                }
                throw error;
            }

            let tool_calls = [...toolCallAccumulator.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, tc]) => tc);

            // Same fallback as non-streaming: parse embedded tool calls from reasoning.
            if (tool_calls.length === 0 && reasoning) {
                tool_calls = parseEmbeddedToolCalls(reasoning);
            }

            return {
                content,
                tool_calls,
                usage: null,
            };
        }, 'streaming chat completion', signal);
    }

    return { createChatCompletion, streamChatCompletion };
}

// ─── Embedded tool call parser ───────────────────────────────

/**
 * Some models embed tool calls in a reasoning/thinking field using a marker
 * format rather than the standard tool_calls field. This parses that format:
 *   <|tool_call_end|>functions.NAME:INDEX{"arg": "value"}
 * and returns standard tool call objects as a fallback.
 */
function parseEmbeddedToolCalls(text) {
    const calls = [];
    const pattern = /<\|tool_call_end\|>\s*functions\.(\w+):\d+\s*({[^<]*})/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const [, name, argsStr] = match;
        try {
            JSON.parse(argsStr);
            calls.push({
                id: `embedded-${calls.length}`,
                type: 'function',
                function: { name, arguments: argsStr.trim() },
            });
        } catch {
            // skip malformed JSON
        }
    }
    return calls;
}

// ─── SSE Parser ──────────────────────────────────────────────

async function fetchWithRetry(url, init, context, signal = null) {
    return withRetry(async (attempt) => {
        throwIfAborted(signal);
        const response = await fetch(url, init);
        if (!response.ok) {
            throw await createHttpError(response, attempt);
        }
        return response;
    }, context, signal);
}

async function withRetry(fn, context, signal = null) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal);
        try {
            return await fn(attempt);
        } catch (error) {
            const normalized = asError(error);
            if (isAbortError(normalized, signal)) {
                throw markAbortError(normalized);
            }
            const shouldRetry = attempt < MAX_ATTEMPTS && isRetryableError(normalized);
            if (!shouldRetry) {
                throw finalizeRetryError(normalized, attempt);
            }

            const delay = getRetryDelay(attempt - 1, normalized.retryAfterMs || null);
            console.warn(`[nanomem/openai] ${context} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${normalized.message}. Retrying in ${Math.round(delay)}ms.`);
            await sleep(delay, signal);
        }
    }

    throw new Error(`OpenAI API ${context} failed after ${MAX_ATTEMPTS} attempts.`);
}

function isRetryableError(error) {
    if (!error) return false;
    if (error.retryable === true) return true;
    if (typeof error.status === 'number') {
        return RETRYABLE_STATUS.has(error.status);
    }
    return isRetryableNetworkError(error);
}

function isRetryableNetworkError(error) {
    if (!error || error.isUserAbort) return false;
    if (error.name === 'TypeError' || error.name === 'AbortError') return true;

    const code = String(error.code || error.cause?.code || '').toUpperCase();
    if (RETRYABLE_ERROR_CODES.has(code)) return true;

    const message = String(error.message || '').toLowerCase();
    return message.includes('failed to fetch')
        || message.includes('network')
        || message.includes('timeout')
        || message.includes('err_network_changed')
        || message.includes('econnreset')
        || message.includes('connection');
}

/**
 * @param {number} attempt
 * @param {number | null} [retryAfterMs]
 * @returns {number}
 */
function getRetryDelay(attempt, retryAfterMs = null) {
    if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(retryAfterMs, MAX_DELAY_MS);
    }

    const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * BASE_DELAY_MS;
    return Math.min(exponential + jitter, MAX_DELAY_MS);
}

function sleep(ms, signal = null) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);

        const cleanup = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener?.('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(createAbortError('OpenAI API request aborted.'));
        };

        if (signal?.aborted) {
            onAbort();
            return;
        }

        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

async function createHttpError(response, attempt = 1) {
    const text = await response.text().catch(() => '');
    const suffix = attempt > 1 ? ` after ${attempt} attempts` : '';
    const error = /** @type {ApiError} */ (new Error(`OpenAI API error ${response.status}${suffix}: ${text}`));
    error.status = response.status;
    error.retryable = RETRYABLE_STATUS.has(response.status);
    error.retryAfterMs = parseRetryAfterMs(response);
    return error;
}

function parseRetryAfterMs(response) {
    const value = response?.headers?.get?.('Retry-After');
    if (!value) return null;

    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
    }

    const date = Date.parse(value);
    if (Number.isFinite(date)) {
        const ms = date - Date.now();
        return ms > 0 ? ms : null;
    }

    return null;
}

function finalizeRetryError(error, attempts) {
    const normalized = asError(error);
    if (attempts <= 1 || normalized._retryFinalized) {
        return normalized;
    }

    if (!normalized.message.includes('after ')) {
        normalized.message = `${normalized.message} (after ${attempts} attempts)`;
    }
    normalized._retryFinalized = true;
    return normalized;
}

/**
 * @param {unknown} error
 * @returns {ApiError}
 */
function asError(error) {
    return /** @type {ApiError} */ (error instanceof Error ? error : new Error(String(error)));
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw createAbortError('OpenAI API request aborted.');
    }
}

function createAbortError(message) {
    const error = /** @type {ApiError} */ (new Error(message));
    error.name = 'AbortError';
    error.isUserAbort = true;
    return error;
}

function isAbortError(error, signal) {
    if (signal?.aborted) {
        return true;
    }
    return error?.name === 'AbortError' || error?.isUserAbort === true;
}

function markAbortError(error) {
    const normalized = asError(error);
    normalized.name = 'AbortError';
    normalized.isUserAbort = true;
    return normalized;
}

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

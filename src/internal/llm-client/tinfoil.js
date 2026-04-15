/**
 * Tinfoil SDK client with fail-closed attestation verification.
 *
 * Loads the `tinfoil` package lazily in both browser and Node environments.
 */
/** @import { ChatCompletionParams, ChatCompletionResponse, LLMClient, MemoryBankLLMConfig, ToolCall } from '../../types.js' */
/**
 * @typedef {Error & { status?: number, retryable?: boolean, retryAfterMs?: number | null, _retryFinalized?: boolean }} ApiError
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
const DEFAULT_CONFIG_REPO = 'tinfoilsh/confidential-model-router';
const DEFAULT_ENCLAVE_URL = 'https://inference.tinfoil.sh';

let tinfoilModulePromise = null;

/**
 * Load TinfoilAI class. If a pre-loaded module is provided (e.g. a browser
 * bundle), use it directly. Otherwise fall back to `import('tinfoil')`.
 *
 * @param {object} [providedModule] — pre-loaded tinfoil module (must export TinfoilAI)
 */
async function loadTinfoilAI(providedModule) {
    if (providedModule) {
        return providedModule.TinfoilAI || providedModule.default;
    }

    if (!tinfoilModulePromise) {
        tinfoilModulePromise = Function('s', 'return import(s)')('tinfoil');
    }

    let mod;
    try {
        mod = await tinfoilModulePromise;
    } catch (error) {
        tinfoilModulePromise = null;
        if (error?.code === 'ERR_MODULE_NOT_FOUND' || String(error?.message || '').includes("Cannot find package 'tinfoil'")) {
            throw new Error('Missing dependency "tinfoil". Run `npm install` in the nanomem package first.');
        }
        throw error;
    }

    return mod.TinfoilAI || mod.default;
}

function normalizeBaseUrl(baseUrl) {
    if (!baseUrl) return null;
    const value = String(baseUrl).trim();
    return value.replace(/\/+$/, '');
}

function normalizeEnclaveUrl(enclaveURL, baseUrl) {
    const raw = normalizeBaseUrl(enclaveURL) || normalizeBaseUrl(baseUrl) || DEFAULT_ENCLAVE_URL;
    return raw.endsWith('/v1') ? raw.slice(0, -3).replace(/\/+$/, '') : raw;
}

function formatVerificationSteps(verification) {
    const steps = verification?.steps || {};
    return Object.entries(steps)
        .filter(([, state]) => state?.status)
        .map(([name, state]) => `${name}=${state.status}${state.error ? ` (${state.error})` : ''}`)
        .join(', ');
}

function normalizeToolCalls(toolCalls) {
    return (toolCalls || []).map((tc) => ({
        id: tc.id || '',
        type: 'function',
        function: {
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '{}',
        },
    }));
}

function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            if (typeof part === 'string') return part;
            if (typeof part?.text === 'string') return part.text;
            return '';
        })
        .join('');
}

function extractReasoningDelta(delta) {
    if (!delta || typeof delta !== 'object') return '';
    if (typeof delta.reasoning === 'string') return delta.reasoning;
    if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
    return '';
}

function buildRequestBody({ model, messages, tools, max_tokens, temperature }) {
    const body = { model, messages };
    if (temperature != null) body.temperature = temperature;
    if (max_tokens != null) body.max_tokens = max_tokens;
    if (tools && tools.length > 0) body.tools = tools;
    return body;
}

function buildRequestOptions(headers) {
    if (!headers || Object.keys(headers).length === 0) {
        return undefined;
    }
    return { headers };
}

/**
 * @param {MemoryBankLLMConfig} [options]
 * @returns {LLMClient}
 */
export function createTinfoilClient(options = /** @type {MemoryBankLLMConfig} */ ({ apiKey: '' })) {
    const {
        apiKey,
        baseUrl,
        headers = {},
        enclaveURL,
        configRepo,
        attestationBundleURL,
        transport,
        tinfoilModule,
    } = options;

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const normalizedEnclaveUrl = normalizeEnclaveUrl(enclaveURL, baseUrl);
    if (!apiKey) {
        throw new Error('createTinfoilClient: options.apiKey is required.');
    }

    let clientPromise = null;

    async function ensureClient() {
        if (!clientPromise) {
            clientPromise = (async () => {
                const TinfoilAI = await loadTinfoilAI(tinfoilModule);
                if (typeof TinfoilAI !== 'function') {
                    throw new Error('Tinfoil package does not export TinfoilAI.');
                }

                const client = new TinfoilAI({
                    bearerToken: apiKey,
                    ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
                    ...(normalizedEnclaveUrl ? { enclaveURL: normalizedEnclaveUrl } : {}),
                    ...(configRepo ? { configRepo } : { configRepo: DEFAULT_CONFIG_REPO }),
                    ...(attestationBundleURL ? { attestationBundleURL } : {}),
                    ...(transport ? { transport } : {}),
                    dangerouslyAllowBrowser: true,
                });

                await client.ready();
                const verification = await client.getVerificationDocument();
                if (!verification?.securityVerified) {
                    throw new Error(`Tinfoil attestation verification failed: ${formatVerificationSteps(verification)}`);
                }
                return client;
            })().catch((error) => {
                clientPromise = null;
                throw error;
            });
        }

        return clientPromise;
    }

    async function createChatCompletion(params) {
        const body = buildRequestBody(params);
        const requestOptions = buildRequestOptions(headers);

        const response = await withRetry(async () => {
            const client = await ensureClient();
            return client.chat.completions.create(body, requestOptions);
        }, 'chat completion request');

        const choice = response?.choices?.[0] || {};
        const message = choice.message || {};

        return {
            content: extractTextContent(message.content),
            tool_calls: normalizeToolCalls(message.tool_calls),
            finish_reason: choice.finish_reason,
            usage: response?.usage || null,
        };
    }

    async function streamChatCompletion({ model, messages, tools, max_tokens, temperature, onDelta, onReasoning }) {
        const body = buildRequestBody({ model, messages, tools, max_tokens, temperature });
        const requestOptions = buildRequestOptions(headers);

        return withRetry(async () => {
            const client = await ensureClient();
            const stream = await client.chat.completions.create({ ...body, stream: true }, requestOptions);

            let content = '';
            let sawStreamData = false;
            let finishReason = null;
            const toolCallAccumulator = new Map();

            try {
                for await (const chunk of stream) {
                    sawStreamData = true;

                    const choice = chunk?.choices?.[0];
                    if (!choice) continue;
                    if (choice.finish_reason) finishReason = choice.finish_reason;

                    const delta = choice.delta;
                    if (!delta) continue;

                    if (delta.content) {
                        content += delta.content;
                        onDelta?.(delta.content);
                    }

                    const reasoning = extractReasoningDelta(delta);
                    if (reasoning) {
                        onReasoning?.(reasoning);
                    }

                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const index = tc.index ?? 0;
                            if (!toolCallAccumulator.has(index)) {
                                toolCallAccumulator.set(index, {
                                    id: tc.id || '',
                                    type: 'function',
                                    function: { name: '', arguments: '' },
                                });
                            }

                            const acc = toolCallAccumulator.get(index);
                            if (!acc) continue;
                            if (tc.id) acc.id = tc.id;
                            if (tc.function?.name) acc.function.name += tc.function.name;
                            if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                        }
                    }
                }
            } catch (error) {
                if (!sawStreamData && isRetryableNetworkError(error)) {
                    const retryError = /** @type {any} */ (asError(error));
                    retryError.retryable = true;
                    throw retryError;
                }
                throw error;
            }

            const tool_calls = [...toolCallAccumulator.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, value]) => value);

            return {
                content,
                tool_calls,
                finish_reason: finishReason || undefined,
                usage: null,
            };
        }, 'streaming chat completion');
    }

    return { createChatCompletion, streamChatCompletion };
}

async function withRetry(fn, context) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            return await fn(attempt);
        } catch (error) {
            const normalized = /** @type {any} */ (asError(error));
            const shouldRetry = attempt < MAX_ATTEMPTS && isRetryableError(normalized);
            if (!shouldRetry) {
                throw finalizeRetryError(normalized, attempt);
            }

            const delay = getRetryDelay(attempt - 1, normalized.retryAfterMs || null);
            console.warn(`[nanomem/tinfoil] ${context} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${normalized.message}. Retrying in ${Math.round(delay)}ms.`);
            await sleep(delay);
        }
    }

    throw new Error(`Tinfoil API ${context} failed after ${MAX_ATTEMPTS} attempts.`);
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

function getRetryDelay(attempt, retryAfterMs = null) {
    if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(retryAfterMs, MAX_DELAY_MS);
    }

    const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * BASE_DELAY_MS;
    return Math.min(exponential + jitter, MAX_DELAY_MS);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createHttpError(response, attempt = 1) {
    const text = await response.text().catch(() => '');
    const suffix = attempt > 1 ? ` after ${attempt} attempts` : '';
    const error = /** @type {ApiError} */ (new Error(`Tinfoil API error ${response.status}${suffix}: ${text}`));
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

/**
 * @param {unknown} error
 * @returns {ApiError}
 */
function asError(error) {
    return /** @type {ApiError} */ (error instanceof Error ? error : new Error(String(error)));
}

function finalizeRetryError(error, attempt) {
    if (!error) return error;
    const typedError = /** @type {any} */ (error);
    if (attempt > 1 && !typedError.retryAttempts) {
        typedError.retryAttempts = attempt;
    }
    return typedError;
}

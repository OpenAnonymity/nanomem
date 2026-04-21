/** @import { ImportDataItemResult, ImportDataOptions, ImportDataResult, MemoryBank, MemoryImportConversation, Message } from '../../types.js' */

import { safeDateTimeIso } from '../format/normalize.js';
import { extractSessionsFromOAFastchatExport } from './oaFastchat.js';
import { isChatGptExport, parseChatGptExport } from './chatgpt.js';
import { isClaudeExport, parseClaudeExport } from './claude.js';
import { parseMarkdownFiles } from './markdown.js';

/**
 * Import one or more conversations/documents into memory using the same ingest
 * path as the CLI import command, but in a browser-safe module.
 *
 * @param {Pick<MemoryBank, 'init' | 'ingest'>} memoryBank
 * @param {string | unknown | MemoryImportConversation | MemoryImportConversation[] | Array<{ path: string, content: string }>} input
 * @param {ImportDataOptions} [options]
 * @returns {Promise<ImportDataResult>}
 */
export async function importData(memoryBank, input, options = {}) {
    const parsed = parseImportInput(input, options);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const signal = options.signal || null;
    const totalItems = parsed.items.length;

    await memoryBank.init();
    onProgress?.({
        stage: 'start',
        totalItems
    });

    /** @type {ImportDataItemResult[]} */
    const results = [];
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let totalWriteCalls = 0;
    let authError = null;
    let aborted = isAbortRequested(signal);

    for (let index = 0; index < parsed.items.length; index += 1) {
        if (isAbortRequested(signal)) {
            aborted = true;
            break;
        }

        const item = parsed.items[index];
        const title = normalizeTitle(item.title);

        onProgress?.({
            stage: 'item_start',
            totalItems,
            itemIndex: index + 1,
            itemTitle: title
        });

        /** @type {ImportDataItemResult} */
        let itemResult;
        if (!item.messages.length) {
            itemResult = {
                title,
                updatedAt: normalizeUpdatedAt(item.updatedAt),
                status: 'skipped',
                writeCalls: 0
            };
        } else {
            try {
                const ingestResult = await memoryBank.ingest(item.messages, {
                    mode: item.mode || parsed.mode,
                    sessionTitle: title || undefined,
                    updatedAt: normalizeUpdatedAt(item.updatedAt) || undefined,
                    signal
                });

                itemResult = {
                    title,
                    updatedAt: normalizeUpdatedAt(item.updatedAt),
                    status: ingestResult.status,
                    writeCalls: ingestResult.writeCalls || 0,
                    ...(ingestResult.error ? { error: ingestResult.error } : {})
                };
            } catch (error) {
                if (isAbortError(error, signal)) {
                    aborted = true;
                    break;
                }
                itemResult = {
                    title,
                    updatedAt: normalizeUpdatedAt(item.updatedAt),
                    status: 'error',
                    writeCalls: 0,
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        }

        results.push(itemResult);
        totalWriteCalls += itemResult.writeCalls || 0;

        if (itemResult.status === 'processed') {
            imported += 1;
        } else if (itemResult.status === 'skipped') {
            skipped += 1;
        } else {
            errors += 1;
            if (!authError && isAuthErrorMessage(itemResult.error)) {
                authError = itemResult.error || 'Unauthorized';
            }
        }

        onProgress?.({
            stage: 'item_complete',
            totalItems,
            itemIndex: index + 1,
            itemTitle: title,
            itemStatus: itemResult.status,
            itemError: itemResult.error || null
        });

        if (authError || isAbortRequested(signal)) {
            aborted = aborted || isAbortRequested(signal);
            break;
        }
    }

    const summary = {
        totalItems,
        imported,
        skipped,
        errors,
        totalWriteCalls,
        authError,
        aborted,
        results
    };

    onProgress?.({
        stage: 'complete',
        totalItems
    });

    return summary;
}

function isAbortRequested(signal) {
    return !!signal?.aborted;
}

function isAbortError(error, signal) {
    if (isAbortRequested(signal)) {
        return true;
    }
    return error?.name === 'AbortError' || error?.isUserAbort === true;
}

/**
 * @param {string | unknown | MemoryImportConversation | MemoryImportConversation[] | Array<{ path: string, content: string }>} input
 * @param {ImportDataOptions} [options]
 * @returns {{ items: MemoryImportConversation[], mode: 'conversation' | 'document' }}
 */
export function parseImportInput(input, options = {}) {
    const normalizedItems = normalizeConversationInput(input);
    if (normalizedItems) {
        return {
            items: normalizedItems,
            mode: inferNormalizedMode(normalizedItems, options.mode)
        };
    }

    const sourceName = String(options.sourceName || '').trim();
    const requestedFormat = normalizeRequestedFormat(options.format, sourceName);
    const parsedJson = parseJsonIfPossible(input);
    const rawText = typeof input === 'string' ? input : null;

    if (requestedFormat === 'markdown') {
        return {
            items: normalizeSessions(parseMarkdownFiles(coerceMarkdownInput(input, sourceName)), 'document'),
            mode: options.mode || 'document'
        };
    }

    if (requestedFormat === 'oa-fastchat' || (requestedFormat === 'auto' && parsedJson?.data?.chats?.sessions)) {
        return {
            items: normalizeSessions(extractSessionsFromOAFastchatExport(parsedJson, {
                sessionId: options.sessionId,
                sessionTitle: options.sessionTitle
            }).map((entry) => ({
                title: entry.session.title || null,
                messages: entry.conversation,
                updatedAt: entry.session.updatedAt
            })), 'conversation'),
            mode: options.mode || 'conversation'
        };
    }

    if (requestedFormat === 'chatgpt' || (requestedFormat === 'auto' && isChatGptExport(parsedJson))) {
        return {
            items: normalizeSessions(parseChatGptExport(parsedJson), 'conversation'),
            mode: options.mode || 'conversation'
        };
    }

    if (requestedFormat === 'claude' || (requestedFormat === 'auto' && isClaudeExport(parsedJson))) {
        return {
            items: normalizeSessions(parseClaudeExport(parsedJson), 'conversation'),
            mode: options.mode || 'conversation'
        };
    }

    if (requestedFormat === 'messages' || (requestedFormat === 'auto' && Array.isArray(parsedJson) && parsedJson.every(isMessageLike))) {
        return {
            items: normalizeSessions([{
                title: titleFromSourceName(sourceName),
                messages: parsedJson,
                updatedAt: null
            }], 'conversation'),
            mode: options.mode || 'conversation'
        };
    }

    if (requestedFormat === 'transcript' || rawText != null) {
        const transcriptMessages = parseTranscriptMessages(rawText || '');
        if (requestedFormat === 'transcript' || transcriptMessages.length > 0) {
            return {
                items: normalizeSessions([{
                    title: titleFromSourceName(sourceName),
                    messages: transcriptMessages,
                    updatedAt: null
                }], 'conversation'),
                mode: options.mode || 'conversation'
            };
        }
    }

    if (rawText != null) {
        return {
            items: normalizeSessions(parseMarkdownFiles(rawText), 'document'),
            mode: options.mode || 'document'
        };
    }

    throw new Error('Unsupported import input. Provide normalized conversations, a supported JSON export, or markdown/text content.');
}

/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function normalizeTitle(value) {
    const text = String(value || '').trim();
    return text || null;
}

/**
 * @param {string | number | null | undefined} value
 * @returns {string | null}
 */
function normalizeUpdatedAt(value) {
    if (value == null || value === '') return null;
    return safeDateTimeIso(value);
}

/**
 * @param {string | undefined} format
 * @param {string} sourceName
 * @returns {'auto' | 'normalized' | 'oa-fastchat' | 'chatgpt' | 'claude' | 'messages' | 'transcript' | 'markdown'}
 */
function normalizeRequestedFormat(format, sourceName) {
    const normalized = String(format || '').trim().toLowerCase();
    if (normalized) {
        if (normalized === 'oa_fastchat') return 'oa-fastchat';
        return /** @type {'auto' | 'normalized' | 'oa-fastchat' | 'chatgpt' | 'messages' | 'transcript' | 'markdown'} */ (normalized);
    }

    if (/\.md$/i.test(sourceName)) return 'markdown';
    return 'auto';
}

/**
 * @param {unknown} input
 * @returns {MemoryImportConversation[] | null}
 */
function normalizeConversationInput(input) {
    if (isConversationLike(input)) {
        return normalizeSessions([input]);
    }

    if (!Array.isArray(input) || input.length === 0) {
        return null;
    }

    if (input.every(isConversationLike)) {
        return normalizeSessions(input);
    }

    if (input.every(isMarkdownRecord)) {
        return normalizeSessions(parseMarkdownFiles(input), 'document');
    }

    return null;
}

/**
 * @param {MemoryImportConversation[]} items
 * @param {'conversation' | 'document' | undefined} fallback
 * @returns {'conversation' | 'document'}
 */
function inferNormalizedMode(items, fallback) {
    if (fallback) return fallback;
    return items.some((item) => item.mode === 'document') ? 'document' : 'conversation';
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function parseJsonIfPossible(value) {
    if (value == null) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        try {
            return JSON.parse(trimmed);
        } catch {
            return null;
        }
    }
    if (typeof value === 'object') {
        return value;
    }
    return null;
}

/**
 * @param {unknown} input
 * @param {string} sourceName
 * @returns {string | Array<{ path: string, content: string }>}
 */
function coerceMarkdownInput(input, sourceName) {
    if (typeof input === 'string') return input;
    if (Array.isArray(input) && input.every(isMarkdownRecord)) return input;
    throw new Error(sourceName
        ? `Expected markdown content for ${sourceName}.`
        : 'Expected markdown content.');
}

/**
 * @param {unknown[]} sessions
 * @returns {MemoryImportConversation[]}
 */
function normalizeSessions(sessions, defaultMode = 'conversation') {
    return sessions
        .map((session) => {
            const s = /** @type {any} */ (session);
            const messages = normalizeMessages(s?.messages || s?.conversation || []);
            const mode = /** @type {'conversation' | 'document'} */ (s?.mode === 'document' ? 'document' : defaultMode);
            return {
                title: normalizeTitle(s?.title || s?.session?.title || null),
                messages,
                updatedAt: normalizeUpdatedAt(s?.updatedAt || s?.session?.updatedAt || null),
                mode
            };
        })
        .filter((session) => session.messages.length > 0 || session.mode === 'document');
}

/**
 * @param {unknown[]} messages
 * @returns {Message[]}
 */
function normalizeMessages(messages) {
    return messages
        .map((message) => {
            const m = /** @type {any} */ (message);
            const role = /** @type {'user' | 'assistant'} */ (m?.role === 'assistant' ? 'assistant' : 'user');
            const content = normalizeMessageContent(m?.content);
            return { role, content };
        })
        .filter((message) => message.content.trim());
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function normalizeMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (!part) return '';
                if (typeof part === 'string') return part;
                const p = /** @type {any} */ (part);
                if (typeof p.text === 'string') return p.text;
                if (typeof p.content === 'string') return p.content;
                return '';
            })
            .filter(Boolean)
            .join('');
    }
    if (content && typeof content === 'object') {
        const c = /** @type {any} */ (content);
        if (typeof c.text === 'string') return c.text;
        if (typeof c.content === 'string') return c.content;
    }
    return '';
}

/**
 * @param {string} rawText
 * @returns {Message[]}
 */
function parseTranscriptMessages(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return [];

    const messages = [];
    const lines = trimmed.split('\n');
    let current = null;
    for (const line of lines) {
        const userMatch = line.match(/^User:\s*(.*)$/i);
        const assistantMatch = line.match(/^Assistant:\s*(.*)$/i);
        if (userMatch) {
            if (current) messages.push(current);
            current = { role: 'user', content: userMatch[1] };
        } else if (assistantMatch) {
            if (current) messages.push(current);
            current = { role: 'assistant', content: assistantMatch[1] };
        } else if (current) {
            current.content += `\n${line}`;
        }
    }
    if (current) messages.push(current);
    return normalizeMessages(messages);
}

/**
 * @param {string} sourceName
 * @returns {string | null}
 */
function titleFromSourceName(sourceName) {
    if (!sourceName) return null;
    const leaf = sourceName.split('/').pop() || sourceName;
    const title = leaf.replace(/\.[^.]+$/u, '').replace(/[_-]+/g, ' ').trim();
    return title || null;
}

/**
 * @param {unknown} value
 * @returns {value is MemoryImportConversation}
 */
function isConversationLike(value) {
    const v = /** @type {any} */ (value);
    return !!v && typeof v === 'object' && Array.isArray(v.messages);
}

/**
 * @param {unknown} value
 * @returns {value is { path: string, content: string }}
 */
function isMarkdownRecord(value) {
    const v = /** @type {any} */ (value);
    return !!v
        && typeof v === 'object'
        && typeof v.path === 'string'
        && typeof v.content === 'string';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isMessageLike(value) {
    const v = /** @type {any} */ (value);
    return !!v
        && typeof v === 'object'
        && (v.role === 'user' || v.role === 'assistant')
        && (typeof v.content === 'string' || Array.isArray(v.content));
}

/**
 * @param {string | undefined} message
 * @returns {boolean}
 */
function isAuthErrorMessage(message) {
    if (!message) return false;
    return message.includes('401') || message.includes('403');
}

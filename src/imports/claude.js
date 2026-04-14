/**
 * Claude export parser.
 *
 * Handles conversations.json from Claude's data export.
 * Format: array of conversation objects, each with a flat `chat_messages` array.
 * Messages have a `content` array of typed blocks (text, tool_use, tool_result, token_budget).
 */
/** @import { ChatGptSession, Message } from '../types.js' */
import { safeDateIso } from '../bullets/normalize.js';

const SKIP_CONTENT_TYPES = new Set([
    'tool_use',
    'tool_result',
    'token_budget',
]);

/**
 * Detect whether parsed JSON is a Claude export.
 * Claude exports are arrays of objects with `chat_messages` and `uuid`.
 * @param {unknown} parsed
 * @returns {boolean}
 */
export function isClaudeExport(parsed) {
    if (!Array.isArray(parsed)) return false;
    if (parsed.length === 0) return false;
    const first = parsed[0];
    return first && typeof first === 'object' && 'chat_messages' in first && 'uuid' in first;
}

/**
 * Parse a Claude export into normalized sessions.
 * @param {unknown[]} conversations — the parsed JSON array
 * @returns {ChatGptSession[]}
 */
export function parseClaudeExport(conversations) {
    if (!Array.isArray(conversations)) {
        throw new Error('Claude export should be an array of conversations.');
    }

    return conversations
        .map(normalizeClaudeConversation)
        .filter(session => session.messages.length > 0);
}

/** @returns {ChatGptSession} */
function normalizeClaudeConversation(conversation) {
    const chatMessages = conversation?.chat_messages || [];
    /** @type {Message[]} */
    const messages = [];

    for (const msg of chatMessages) {
        const sender = msg?.sender;
        if (sender !== 'human' && sender !== 'assistant') continue;

        /** @type {'user' | 'assistant'} */
        const role = sender === 'human' ? 'user' : 'assistant';
        const text = extractText(msg?.content);

        if (!text.trim()) continue;

        messages.push({ role, content: text });
    }

    const title = (conversation?.name || '').trim() || null;
    const updatedAt = conversation?.updated_at
        ? safeDateIso(conversation.updated_at)
        : null;

    return { title, messages, updatedAt };
}

function extractText(contentBlocks) {
    if (!Array.isArray(contentBlocks)) return '';

    const parts = [];
    for (const block of contentBlocks) {
        if (!block || typeof block !== 'object') continue;
        if (SKIP_CONTENT_TYPES.has(block.type)) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        }
    }

    return parts.join('\n').trim();
}

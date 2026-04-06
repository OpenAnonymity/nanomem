/**
 * ChatGPT export parser.
 *
 * Handles conversations.json from ChatGPT's "Export data" feature.
 * Format: array of conversation objects, each with a tree-structured `mapping`.
 *
 * Based on the OA Fastchat chatgptImporter.
 */
/** @import { ChatGptSession } from '../types.js' */
import { safeDateIso } from '../bullets/normalize.js';

const SKIP_CONTENT_TYPES = new Set([
    'user_editable_context',
    'reasoning_recap',
    'thoughts',
]);

/**
 * Detect whether parsed JSON is a ChatGPT export.
 * ChatGPT exports are arrays of objects with `mapping` and `current_node`.
 * @param {unknown} parsed
 * @returns {boolean}
 */
export function isChatGptExport(parsed) {
    if (!Array.isArray(parsed)) return false;
    if (parsed.length === 0) return false;
    const first = parsed[0];
    return first && typeof first === 'object' && ('mapping' in first);
}

/**
 * Parse a ChatGPT export into normalized sessions.
 * @param {unknown[]} conversations — the parsed JSON array
 * @returns {ChatGptSession[]}
 */
export function parseChatGptExport(conversations) {
    if (!Array.isArray(conversations)) {
        throw new Error('ChatGPT export should be an array of conversations.');
    }

    return conversations
        .map(normalizeChatGptConversation)
        .filter(session => session.messages.length > 0);
}

function normalizeChatGptConversation(conversation) {
    const rawMessages = getConversationPathMessages(conversation);
    const messages = [];

    for (const message of rawMessages) {
        const authorRole = message?.author?.role;

        // Skip tool and system messages
        if (authorRole === 'tool' || authorRole === 'system' || authorRole === 'developer') continue;
        if (message?.metadata?.is_visually_hidden_from_conversation) continue;

        const contentType = message?.content?.content_type || '';
        if (SKIP_CONTENT_TYPES.has(contentType)) continue;

        /** @type {'assistant' | 'user'} */
        const role = authorRole === 'assistant' ? 'assistant' : 'user';
        const text = extractText(message?.content);

        if (!text.trim()) continue;

        messages.push({ role, content: text });
    }

    const title = (conversation?.title || '').trim() || null;
    const updatedAt = conversation?.update_time
        ? safeDateIso(String(conversation.update_time * 1000))
        : null;
    return { title, messages, updatedAt };
}

function getConversationPathMessages(conversation) {
    const mapping = conversation?.mapping || {};
    const currentNode = conversation?.current_node;

    if (!currentNode || !mapping[currentNode]) {
        // Fallback: all messages sorted by time
        return Object.values(mapping)
            .map(node => node?.message)
            .filter(Boolean)
            .sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
    }

    // Walk from current_node to root, then reverse
    const ordered = [];
    const visited = new Set();
    let nodeId = currentNode;
    while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
        visited.add(nodeId);
        const node = mapping[nodeId];
        if (node?.message) {
            ordered.push(node.message);
        }
        nodeId = node.parent;
    }
    return ordered.reverse();
}

function isInternalToolCodeBlock(content) {
    if (!content || typeof content !== 'object') return false;
    const contentType = content.content_type || '';
    if (contentType !== 'code') return false;
    if (typeof content.text !== 'string') return false;

    const lang = (content.language || '').trim().toLowerCase();
    if (lang && lang !== 'unknown') return false;

    const raw = content.text.trim();

    // Function-call style: search("..."), web.search("..."), etc.
    if (/^[a-z_][a-z0-9_.]*\s*\(/i.test(raw)) return true;

    // JSON tool payloads
    if (raw.startsWith('{') && raw.endsWith('}')) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed?.search_query) || Array.isArray(parsed?.image_query)) return true;
            if (Array.isArray(parsed?.open)) return true;
            if (typeof parsed?.response_length === 'string' && !parsed.text && !parsed.content) return true;
        } catch { /* not JSON, keep it */ }
    }

    return false;
}

function extractText(content) {
    if (!content || typeof content !== 'object') return '';

    const contentType = content.content_type || '';
    const parts = [];

    if (contentType === 'code' && typeof content.text === 'string') {
        if (isInternalToolCodeBlock(content)) return '';
        const lang = content.language ? content.language.trim() : '';
        parts.push(lang ? `\`\`\`${lang}\n${content.text}\n\`\`\`` : `\`\`\`\n${content.text}\n\`\`\``);
    } else {
        if (Array.isArray(content.parts)) {
            for (const part of content.parts) {
                if (typeof part === 'string') {
                    parts.push(part);
                } else if (part && typeof part === 'object') {
                    if (typeof part.text === 'string') parts.push(part.text);
                    else if (typeof part.content === 'string') parts.push(part.content);
                }
            }
        }
        if (typeof content.text === 'string' && !parts.length) {
            parts.push(content.text);
        }
        if (typeof content.result === 'string') {
            parts.push(content.result);
        }
    }

    return parts.join('\n').trim();
}

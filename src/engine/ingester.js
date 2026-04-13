/**
 * MemoryIngester — Write path for agentic memory.
 *
 * Takes a conversation (array of messages) and uses tool-calling via the
 * agentic loop to decide whether to create/append/update memory files.
 */
/** @import { IngestOptions, IngestResult, LLMClient, Message, StorageBackend, ToolDefinition } from '../types.js' */
import { runAgenticToolLoop } from './toolLoop.js';
import { createExtractionExecutors } from './executors.js';
import { resolvePromptSet } from '../prompt_sets/index.js';
import {
    compactBullets,
    ensureBulletMetadata,
    inferTopicFromPath,
    parseBullets,
    renderCompactedDocument,
    todayIsoDate
} from '../bullets/index.js';

const MAX_CONVERSATION_CHARS = 128000;

/** @type {ToolDefinition} */
const T_READ_FILE = {
    type: 'function',
    function: {
        name: 'read_file',
        description: 'Read an existing memory file before writing.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path (e.g. personal/about.md)' }
            },
            required: ['path']
        }
    }
};

/** @type {ToolDefinition} */
const T_CREATE_NEW_FILE = {
    type: 'function',
    function: {
        name: 'create_new_file',
        description: 'Create a new memory file for a topic not covered by any existing file.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path (e.g. projects/recipe-app.md)' },
                content: { type: 'string', description: 'Bullet-point content to write' }
            },
            required: ['path', 'content']
        }
    }
};

/** @type {ToolDefinition} */
const T_APPEND_MEMORY = {
    type: 'function',
    function: {
        name: 'append_memory',
        description: 'Append new bullet points to an existing memory file.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to append to' },
                content: { type: 'string', description: 'Bullet-point content to append' }
            },
            required: ['path', 'content']
        }
    }
};

/** @type {ToolDefinition} */
const T_UPDATE_BULLETS = {
    type: 'function',
    function: {
        name: 'update_bulletss',
        description: 'Replace one or more bullet facts in an existing memory file in a single call. Each entry requires the exact existing fact text and its corrected replacement. Only matched bullets are changed — the rest of the file is untouched.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path containing the bullets to update' },
                updates: {
                    type: 'array',
                    description: 'List of bullet updates to apply',
                    items: {
                        type: 'object',
                        properties: {
                            old_fact: { type: 'string', description: 'Exact fact text of the bullet to replace (pipe-delimited metadata is fine)' },
                            new_fact: { type: 'string', description: 'Corrected fact text (plain text only, no metadata)' }
                        },
                        required: ['old_fact', 'new_fact']
                    }
                }
            },
            required: ['path', 'updates']
        }
    }
};

/**
 * Tool sets per ingestion mode.
 * `add`    — can only write new content.
 * `update` — can only edit existing files (no create/append).
 * Others   — full access.
 * @type {Record<string, ToolDefinition[]>}
 */
const TOOLS_BY_MODE = {
    add:          [T_READ_FILE, T_CREATE_NEW_FILE, T_APPEND_MEMORY],
    update:       [T_READ_FILE, T_UPDATE_BULLETS],
};

const EXTRACTION_TOOLS = [T_READ_FILE, T_CREATE_NEW_FILE, T_APPEND_MEMORY, T_UPDATE_BULLETS];

class MemoryIngester {
    constructor({ backend, bulletIndex, llmClient, model, onToolCall }) {
        this._backend = backend;
        this._bulletIndex = bulletIndex;
        this._llmClient = llmClient;
        this._model = model;
        this._onToolCall = onToolCall || null;
    }

    /**
     * Ingest memory from a conversation.
     *
     * @param {Message[]} messages
     * @param {IngestOptions} [options]
     * @returns {Promise<IngestResult>}
     */
    async ingest(messages, options = {}) {
        const updatedAt = options.updatedAt || todayIsoDate();
        const onToolCall = this._onToolCall;
        if (!messages || messages.length === 0) return { status: 'skipped', writeCalls: 0 };

        // Support both `mode` and legacy `extractionMode`
        const mode = options.mode || options.extractionMode || 'conversation';
        const isDocument = mode === 'document';
        const conversationText = isDocument
            ? this._buildDocumentText(messages)
            : this._buildConversationText(messages);
        if (!conversationText) return { status: 'skipped', writeCalls: 0 };

        await this._backend.init();
        const index = await this._backend.getTree() || '';

        const { ingestionPrompt } = resolvePromptSet(mode);
        const systemPrompt = ingestionPrompt.replace('{INDEX}', index);
        const writes = [];
        const toolExecutors = createExtractionExecutors(this._backend, {
            normalizeContent: (content, path) => this._normalizeGeneratedContent(content, path, updatedAt, isDocument),
            mergeWithExisting: (existing, incoming, path) => this._mergeWithExisting(existing, incoming, path, updatedAt, isDocument),
            refreshIndex: (path) => this._bulletIndex.refreshPath(path),
            onWrite: (path, before, after) => writes.push({ path, before, after }),
        });

        const userMessage = isDocument
            ? `Document content:\n\`\`\`\n${conversationText}\n\`\`\``
            : `Conversation:\n\`\`\`\n${conversationText}\n\`\`\``;

        const tools = TOOLS_BY_MODE[mode] || EXTRACTION_TOOLS;

        let toolCallLog;
        try {
            const result = await runAgenticToolLoop({
                llmClient: this._llmClient,
                model: this._model,
                tools,
                toolExecutors,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ],
                maxIterations: 12,
                maxOutputTokens: 4000,
                temperature: 0,
                onToolCall: (name, args, result, meta) => {
                    onToolCall?.(name, args, result, meta);
                }
            });
            toolCallLog = result.toolCallLog;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { status: 'error', writeCalls: 0, error: message };
        }

        const writeTools = ['create_new_file', 'append_memory', 'update_bullets', 'archive_memory', 'delete_memory'];
        const writeCalls = toolCallLog.filter(e => writeTools.includes(e.name));

        return { status: 'processed', writeCalls: writeCalls.length, writes };
    }

    _buildConversationText(messages) {
        let text = '';
        for (const msg of messages) {
            const role = msg.role === 'user' ? 'User' : 'Assistant';
            const content = msg.content || '';
            text += `${role}: ${content}\n\n`;
            if (text.length > MAX_CONVERSATION_CHARS) break;
        }
        return text.trim();
    }

    _buildDocumentText(messages) {
        // For documents, concatenate content blocks without role labels.
        // Multiple messages are treated as sections of the same document.
        return messages
            .map(m => (m.content || '').trim())
            .filter(Boolean)
            .join('\n\n')
            .slice(0, MAX_CONVERSATION_CHARS);
    }

    _normalizeGeneratedContent(content, path, updatedAt, isDocument = false) {
        const incomingBullets = parseBullets(content);
        if (incomingBullets.length === 0) {
            return content;
        }

        const defaultTopic = inferTopicFromPath(path);
        const normalized = incomingBullets.map((bullet) => {
            // Preserve existing updatedAt so unchanged bullets aren't re-stamped.
            // Bullets without a date still fall back to updatedAt (today).
            const b = ensureBulletMetadata(bullet, { defaultTopic, updatedAt });
            if (isDocument && b.source === 'user_statement') b.source = 'document';
            return b;
        });
        const compacted = compactBullets(normalized, { defaultTopic, maxActivePerTopic: 1000 });
        return renderCompactedDocument(compacted.working, compacted.longTerm, compacted.history, { titleTopic: defaultTopic });
    }

    _mergeWithExisting(existing, incoming, path, updatedAt, isDocument = false) {
        const existingText = String(existing || '');
        const incomingText = String(incoming || '');
        const defaultTopic = inferTopicFromPath(path);

        const existingBullets = parseBullets(existingText)
            .map((bullet) => ensureBulletMetadata(bullet, { defaultTopic }));
        const incomingBullets = parseBullets(incomingText)
            .map((bullet) => {
                const b = ensureBulletMetadata({ ...bullet, updatedAt: null }, { defaultTopic, updatedAt });
                if (isDocument && b.source === 'user_statement') b.source = 'document';
                return b;
            });

        if (incomingBullets.length === 0) {
            return existingText
                ? `${existingText}\n\n${incomingText}`
                : incomingText;
        }

        if (existingBullets.length === 0) {
            const compacted = compactBullets(incomingBullets, { defaultTopic, maxActivePerTopic: 1000 });
            return renderCompactedDocument(compacted.working, compacted.longTerm, compacted.history, { titleTopic: defaultTopic });
        }

        const merged = [...existingBullets, ...incomingBullets];
        const compacted = compactBullets(merged, { defaultTopic, maxActivePerTopic: 1000 });
        return renderCompactedDocument(compacted.working, compacted.longTerm, compacted.history, { titleTopic: defaultTopic });
    }
}

export { MemoryIngester };

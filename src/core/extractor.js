/**
 * MemoryExtractor — Write path for agentic memory.
 *
 * Takes a conversation (array of messages) and uses tool-calling via the
 * agentic loop to examine the conversation and decide whether to
 * create/append/update memory files.
 */
import { runAgenticToolLoop } from './toolLoop.js';
import { createExtractionExecutors } from '../storage/interface.js';
import {
    compactBullets,
    ensureBulletMetadata,
    inferTopicFromPath,
    parseMemoryBullets,
    renderCompactedMemoryDocument,
    todayIsoDate
} from '../bullets/utils.js';

const MAX_CONVERSATION_CHARS = 128000;

const EXTRACTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the content of an existing memory file to inspect before writing.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read (e.g. personal/about.md)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_new_file',
            description: 'Create a new memory file. Use for an entirely new topic that does not fit any existing file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path (e.g. projects/recipe-app.md)' },
                    content: { type: 'string', description: 'Bullet-point content to write' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_new_folder',
            description: 'Create a new folder in the memory filesystem.',
            parameters: {
                type: 'object',
                properties: {
                    folder_path: { type: 'string', description: 'Folder path to create (e.g. projects)' }
                },
                required: ['folder_path']
            }
        }
    },
    {
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
    },
    {
        type: 'function',
        function: {
            name: 'update_memory',
            description: 'Overwrite an existing memory file with new content. Use when existing content is stale or contradicted.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to update' },
                    content: { type: 'string', description: 'Complete new content for the file' }
                },
                required: ['path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'archive_memory',
            description: 'Remove a specific bullet point or item from a memory file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path containing the item' },
                    item_text: { type: 'string', description: 'The exact text of the item to remove' }
                },
                required: ['path', 'item_text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_memory',
            description: 'Delete an entire memory file.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to delete' }
                },
                required: ['path']
            }
        }
    }
];

const EXTRACTION_SYSTEM_PROMPT = `You are a memory manager. After reading a conversation, decide if any concrete, reusable facts should be saved to the user's memory files.

Save information that is likely to help in a future conversation. Be selective, but when the user clearly states durable facts or active plans that would help later, save them.

Do NOT save:
- Information already present in existing files (use read_file to check first)
- Vague or transient details (e.g. "help me with this", "thanks")
- The assistant's own reasoning or suggestions — only facts grounded in what the user said
- Sensitive secrets (passwords, auth tokens, private keys, full payment data, government IDs)

Current memory index:
\`\`\`
{INDEX}
\`\`\`

Directory structure — create topic-specific files, one per distinct subject:
- personal/about.md — Core identity: name, age, location, background
- personal/family.md — Family members, relationships, family health
- health/<condition>.md — One file per health condition or medical topic (e.g. health/thyroid.md, health/anxiety.md)
- work/<topic>.md — Career, job, professional skills (e.g. work/role.md, work/negotiation.md)
- interests/<topic>.md — Hobbies, media preferences, activities (e.g. interests/running.md, interests/cooking.md)
- pets/<name>.md — Pet information
- projects/<project-name>.md — One file per project/app/task
- preferences/<topic>.md — Dietary, lifestyle, or other preferences
- Available namespaces: personal/, health/, work/, interests/, pets/, projects/, preferences/, temporary/

**Key principle: Create a NEW file for each distinct topic rather than cramming unrelated facts into one file.** For example, thyroid health goes in health/thyroid.md, not personal/about.md. A pet cat goes in pets/ not personal/about.md.

Instructions:
1. Read the conversation below and decide if anything new should be saved.
2. If a matching file already exists in the index, use read_file first to avoid duplicates.
3. If no relevant file exists yet, create_new_file directly.
4. Use append_memory to add to existing files when the topic matches, or create_new_file for new topics.
5. Prefer this simple bullet format: "- Fact text | topic=topic-name | updated_at=YYYY-MM-DD"
6. You may optionally add tier=working for clearly short-term or in-progress context. If you are unsure, omit tier and just save the fact.
7. Facts usually worth saving when first learned include allergies, health conditions, where the user lives, job/role, ongoing tech stack, pets, family members, durable preferences, and active plans.
8. If a fact is time-sensitive, include date context in the text. You may optionally add review_at or expires_at.
9. If nothing new is worth remembering, simply stop without calling any write tools.

Rules:
- One file per distinct topic. Do NOT put unrelated facts in the same file.
- Create new files freely — it is better to have many focused files than one bloated file.
- Use update_memory only if a fact is now stale or contradicted.
- Do not skip obvious facts just because the schema supports extra metadata.
- Content should be raw facts only — no filler commentary.`;


class MemoryExtractor {
    constructor({ backend, bulletIndex, llmClient, model }) {
        this._backend = backend;
        this._bulletIndex = bulletIndex;
        this._llmClient = llmClient;
        this._model = model;
    }

    /**
     * Extract memory from a conversation.
     * @param {Array<{role: string, content: string}>} messages — conversation messages
     * @param {object} [options]
     * @param {AbortSignal} [options.signal] — cancellation signal
     * @param {Function} [options.onToolCall] — callback(name, args, result) for progress
     * @returns {Promise<{ status: 'processed'|'skipped', writeCalls: number }>}
     */
    async extract(messages, { signal, onToolCall } = {}) {
        if (!messages || messages.length < 2) return { status: 'skipped', writeCalls: 0 };

        const conversationText = this._buildConversationText(messages);
        if (!conversationText) return { status: 'skipped', writeCalls: 0 };

        if (signal?.aborted) return { status: 'skipped', writeCalls: 0 };

        await this._backend.init();
        const index = await this._backend.getIndex() || '';

        const systemPrompt = EXTRACTION_SYSTEM_PROMPT.replace('{INDEX}', index);
        const toolExecutors = createExtractionExecutors(this._backend, {
            normalizeContent: (content, path) => this._normalizeGeneratedContent(content, path),
            mergeWithExisting: (existing, incoming, path) => this._mergeWithExisting(existing, incoming, path),
            refreshIndex: (path) => this._bulletIndex.refreshPath(path)
        });

        const { toolCallLog } = await runAgenticToolLoop({
            llmClient: this._llmClient,
            model: this._model,
            tools: EXTRACTION_TOOLS,
            toolExecutors,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Conversation:\n\`\`\`\n${conversationText}\n\`\`\`` }
            ],
            maxIterations: 6,
            maxOutputTokens: 500,
            temperature: 0,
            signal,
            onToolCall: (name, args, result) => {
                onToolCall?.(name, args, result);
            }
        });

        const writeTools = ['create_new_file', 'append_memory', 'update_memory', 'archive_memory', 'delete_memory'];
        const writeCalls = toolCallLog.filter(e => writeTools.includes(e.name));

        return { status: 'processed', writeCalls: writeCalls.length };
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

    _normalizeGeneratedContent(content, path) {
        const incomingBullets = parseMemoryBullets(content);
        if (incomingBullets.length === 0) {
            return content;
        }

        const defaultTopic = inferTopicFromPath(path);
        const normalized = incomingBullets.map((bullet) =>
            ensureBulletMetadata(bullet, { defaultTopic, updatedAt: todayIsoDate() })
        );
        const compacted = compactBullets(normalized, { defaultTopic, maxActivePerTopic: 1000 });
        return renderCompactedMemoryDocument(compacted.working, compacted.longTerm, compacted.history, { titleTopic: defaultTopic });
    }

    _mergeWithExisting(existing, incoming, path) {
        const existingText = String(existing || '');
        const incomingText = String(incoming || '');
        const defaultTopic = inferTopicFromPath(path);
        const today = todayIsoDate();

        const existingBullets = parseMemoryBullets(existingText)
            .map((bullet) => ensureBulletMetadata(bullet, { defaultTopic, updatedAt: today }));
        const incomingBullets = parseMemoryBullets(incomingText)
            .map((bullet) => ensureBulletMetadata(bullet, { defaultTopic, updatedAt: today }));

        if (incomingBullets.length === 0) {
            return existingText
                ? `${existingText}\n\n${incomingText}`
                : incomingText;
        }

        if (existingBullets.length === 0) {
            const compacted = compactBullets(incomingBullets, { defaultTopic, maxActivePerTopic: 1000 });
            return renderCompactedMemoryDocument(compacted.working, compacted.longTerm, compacted.history, { titleTopic: defaultTopic });
        }

        const merged = [...existingBullets, ...incomingBullets];
        const compacted = compactBullets(merged, { defaultTopic, maxActivePerTopic: 1000 });
        return renderCompactedMemoryDocument(compacted.working, compacted.longTerm, compacted.history, { titleTopic: defaultTopic });
    }
}

export { MemoryExtractor };

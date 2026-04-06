/**
 * MemoryIngester — Write path for agentic memory.
 *
 * Takes a conversation (array of messages) and uses tool-calling via the
 * agentic loop to decide whether to create/append/update memory files.
 */
import { runAgenticToolLoop } from './toolLoop.js';
import { createExtractionExecutors } from './executors.js';
import {
    compactBullets,
    ensureBulletMetadata,
    inferTopicFromPath,
    parseBullets,
    renderCompactedDocument,
    todayIsoDate
} from '../bullets/index.js';

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

CRITICAL: Only save facts the user explicitly stated. Do NOT infer, extrapolate, or fabricate information.

Save information that is likely to help in a future conversation. Be selective — only save durable facts, not transient conversation details.

Do NOT save:
- Anything the user did not explicitly say (no inferences, no extrapolations, no "likely" facts)
- Information already present in existing files (use read_file to check first)
- Transient details (greetings, "help me with this", "thanks", questions without lasting answers)
- The assistant's own reasoning, suggestions, or knowledge — only what the user stated
- Sensitive secrets (passwords, auth tokens, private keys, full payment data, government IDs)
- Opinions the assistant expressed unless the user explicitly agreed with them

Current memory index:
\`\`\`
{INDEX}
\`\`\`

**Key principle: Create a NEW file for each distinct topic rather than cramming unrelated facts into one file.** Organize files into folders by domain (e.g. health/, work/, personal/) and create topic-specific files within them (e.g. health/allergies.md, work/role.md). The folder structure should emerge naturally from the topics discussed.

Instructions:
1. Read the conversation below and identify facts the user explicitly stated.
2. If a matching file already exists in the index, use read_file first to avoid duplicates.
3. If no relevant file exists yet, create_new_file directly.
4. Use append_memory to add to existing files when the topic matches, or create_new_file for new topics.
5. Use this bullet format: "- Fact text | topic=topic-name | source=SOURCE | confidence=LEVEL | updated_at=YYYY-MM-DD"
6. Source values:
   - source=user_statement — the user directly said this. This is the PRIMARY source. Use it for the vast majority of saved facts.
   - source=llm_infer — use ONLY when combining multiple explicit user statements into an obvious conclusion (e.g. user said "I work at Acme" and "Acme is in SF" → "Works in SF"). Never use this to guess, extrapolate, or fill in gaps. When in doubt, do not save.
7. Confidence: high for direct user statements, medium for llm_infer. Never save low-confidence items.
8. You may optionally add tier=working for clearly short-term or in-progress context. If you are unsure, omit tier and just save the fact.
9. Facts worth saving: allergies, health conditions, location, job/role, tech stack, pets, family members, durable preferences, and active plans — but ONLY if the user explicitly mentioned them.
10. If a fact is time-sensitive, include date context in the text. You may optionally add review_at or expires_at.
11. If nothing new is worth remembering, simply stop without calling any write tools. Saving nothing is better than saving something wrong.

Rules:
- One file per distinct topic. Do NOT put unrelated facts in the same file.
- Create new files freely — it is better to have many focused files than one bloated file.
- Use update_memory only if a fact is now stale or contradicted.
- When a new explicit user statement contradicts an older one on the same topic, prefer the newer statement. If a user statement conflicts with an inference, the user statement always wins.
- If a conflict is ambiguous, preserve both versions rather than deleting one.
- Do not skip obvious facts just because the schema supports extra metadata.
- Content should be raw facts only — no filler commentary.`;


class MemoryIngester {
    /**
     * @param {object} deps
     * @param {Function} [deps.onToolCall] — callback(name, args, result)
     */
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
     * @param {Array<{role: string, content: string}>} messages
     * @param {object} [options]
     * @param {string} [options.updatedAt] — ISO date for bullet timestamps (defaults to today)
     * @returns {Promise<{status: 'processed'|'skipped'|'error', writeCalls: number, error?: string}>}
     */
    async ingest(messages, options = {}) {
        const updatedAt = options.updatedAt || todayIsoDate();
        const onToolCall = this._onToolCall;
        if (!messages || messages.length === 0) return { status: 'skipped', writeCalls: 0 };

        const conversationText = this._buildConversationText(messages);
        if (!conversationText) return { status: 'skipped', writeCalls: 0 };

        await this._backend.init();
        const index = await this._backend.getTree() || '';

        const systemPrompt = EXTRACTION_SYSTEM_PROMPT
            .replace('{INDEX}', index);
        const toolExecutors = createExtractionExecutors(this._backend, {
            normalizeContent: (content, path) => this._normalizeGeneratedContent(content, path, updatedAt),
            mergeWithExisting: (existing, incoming, path) => this._mergeWithExisting(existing, incoming, path, updatedAt),
            refreshIndex: (path) => this._bulletIndex.refreshPath(path)
        });

        let toolCallLog;
        try {
            const result = await runAgenticToolLoop({
                llmClient: this._llmClient,
                model: this._model,
                tools: EXTRACTION_TOOLS,
                toolExecutors,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Conversation:\n\`\`\`\n${conversationText}\n\`\`\`` }
                ],
                maxIterations: 12,
                maxOutputTokens: 500,
                temperature: 0,
                onToolCall: (name, args, result) => {
                    onToolCall?.(name, args, result);
                }
            });
            toolCallLog = result.toolCallLog;
        } catch (error) {
            return { status: 'error', writeCalls: 0, error: error.message };
        }

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

    _normalizeGeneratedContent(content, path, updatedAt) {
        const incomingBullets = parseBullets(content);
        if (incomingBullets.length === 0) {
            return content;
        }

        const defaultTopic = inferTopicFromPath(path);
        const normalized = incomingBullets.map((bullet) =>
            ensureBulletMetadata({ ...bullet, updatedAt: null }, { defaultTopic, updatedAt })
        );
        const compacted = compactBullets(normalized, { defaultTopic, maxActivePerTopic: 1000 });
        return renderCompactedDocument(compacted.working, compacted.longTerm, compacted.history, { titleTopic: defaultTopic });
    }

    _mergeWithExisting(existing, incoming, path, updatedAt) {
        const existingText = String(existing || '');
        const incomingText = String(incoming || '');
        const defaultTopic = inferTopicFromPath(path);

        const existingBullets = parseBullets(existingText)
            .map((bullet) => ensureBulletMetadata(bullet, { defaultTopic }));
        const incomingBullets = parseBullets(incomingText)
            .map((bullet) => ensureBulletMetadata({ ...bullet, updatedAt: null }, { defaultTopic, updatedAt }));

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

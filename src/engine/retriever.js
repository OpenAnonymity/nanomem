/**
 * MemoryRetriever — Read path for agentic memory.
 *
 * Uses tool-calling via the agentic loop to let the LLM search, read,
 * and assemble relevant memory context. Falls back to brute-force text
 * search if the LLM call fails.
 */
/** @import { LLMClient, Message, ProgressEvent, RetrievalResult, AugmentQueryResult, StorageBackend, ToolDefinition } from '../types.js' */
import { runAgenticToolLoop } from './toolLoop.js';
import { createAugmentQueryExecutor, createRetrievalExecutors } from './executors.js';
import { trimRecentConversation } from './recentConversation.js';
import {
    normalizeFactText,
    parseBullets,
    renderBullet,
    scoreBullet,
    tokenizeQuery
} from '../bullets/index.js';

const MAX_FILES_TO_LOAD = 8;
const MAX_TOTAL_CONTEXT_CHARS = 4000;
const MAX_SNIPPETS = 18;
const MAX_RECENT_CONTEXT_CHARS = 2000;

/** @type {ToolDefinition[]} */
const RETRIEVAL_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List all files and subdirectories in a directory. Use this to discover all files in a domain (e.g. "health" to see all health condition files).',
            parameters: {
                type: 'object',
                properties: {
                    dir_path: { type: 'string', description: 'Directory path (e.g. "health", "personal", "work"). Use empty string for root.' }
                },
                required: ['dir_path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'retrieve_file',
            description: 'Search memory files by keyword. Returns paths of files whose content or path matches the query. Use read_file instead if you already know the file path.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keyword to search for in file contents (e.g. "cooking", "Stanford", "project")' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the content of a memory file by its path.',
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
            name: 'assemble_context',
            description: 'Synthesize and return the final answer to the user\'s query based on what you read. Do NOT paste raw file content — write a clear, direct answer in plain prose. You MUST call this when done, even if nothing relevant was found (pass an empty string).',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'A synthesized, human-readable answer to the query derived from the memory files. Write prose, not raw bullet dumps. If nothing relevant was found, pass an empty string.' }
                },
                required: ['content']
            }
        }
    }
];

const RETRIEVAL_SYSTEM_PROMPT = `You are a memory retrieval assistant. Your job is to find and assemble relevant personal context from the user's memory files to help answer their query.

You have access to a memory filesystem. The index below shows all available files:

\`\`\`
{INDEX}
\`\`\`

Instructions:
1. Look at the index above. If you can already see relevant file paths, use read_file directly to read them.
2. Use retrieve_file only when you need to search by keyword (e.g. "cooking", "Stanford") — it searches file contents, not paths.
3. Use list_directory to see ALL files in a directory when the query relates to a broad domain (e.g. list "health" for any medicine/health query).
4. Read at most ${MAX_FILES_TO_LOAD} files.
5. You MUST always finish by calling assemble_context — write a direct, synthesized answer in plain prose based on what you read. Do NOT paste raw bullet lists or file content. If the query is historical or comparative, reason over the facts and answer accordingly.
6. If nothing is relevant, call assemble_context with an empty string.

IMPORTANT — Domain-exhaustive retrieval:
- When a query touches a domain (health, work, personal), prefer completeness over selectivity within that domain. File descriptions may be incomplete.
- For family-related queries: check personal/family.md AND any health files about family members.

When recent conversation context is provided alongside the query, use it to resolve references like "that", "the same", "what we discussed", etc. The conversation shows what the user has been talking about recently.

Only include content that genuinely helps answer this specific query. Do not include unrelated files from other domains.`;

/** @type {ToolDefinition} */
const AUGMENT_QUERY_TOOL = {
    type: 'function',
    function: {
        name: 'augment_query',
        description: 'Hand off the original user query plus the minimal relevant memory file paths to the prompt crafter. Call this exactly once after you have identified the relevant files.',
        parameters: {
            type: 'object',
            properties: {
                user_query: {
                    type: 'string',
                    description: 'The original user query copied verbatim. Do not paraphrase it.'
                },
                memory_files: {
                    type: 'array',
                    description: 'The minimal set of relevant memory file paths needed by the prompt crafter.'
                }
            },
            required: ['user_query', 'memory_files']
        }
    }
};

const AUGMENT_SYSTEM_ADDENDUM = `

## Augment Query

After reading memory files, you MUST call augment_query with the original user query plus the minimal relevant memory file paths. Do NOT draft the final prompt in the tool arguments. The augment_query tool itself will run the prompt-crafting pass.

Rules:
- Read the relevant files first so you know which paths matter.
- Set user_query to the original user message verbatim.
- Pass only the minimum set of memory file paths needed for a high-quality answer.
- Do not include any facts, summaries, names, or rewritten instructions in the tool arguments.
- If a file does not materially improve the final answer, leave it out.
- If a file only confirms a general interest already obvious from the query, leave it out.
- If nothing relevant is found, call augment_query with an empty memory_files array.
- Make exactly one augment_query call for this user message.
- Do NOT call assemble_context in this mode.
`;

async function collectReadFiles(toolCallLog, backend) {
    const files = [];
    const seenPaths = new Set();
    for (const entry of toolCallLog) {
        if (entry.name !== 'read_file' || !entry.args?.path || !entry.result) continue;
        const path = typeof backend.resolvePath === 'function'
            ? (await backend.resolvePath(entry.args.path)) || entry.args.path
            : entry.args.path;
        if (seenPaths.has(path)) continue;
        try {
            const parsed = JSON.parse(entry.result);
            if (parsed.error) continue;
        } catch {
            // Non-JSON results are file contents.
        }
        seenPaths.add(path);
        files.push({ path, content: entry.result });
    }
    return files;
}


class MemoryRetriever {
    constructor({ backend, bulletIndex, llmClient, model, onProgress, onModelText }) {
        this._backend = backend;
        this._bulletIndex = bulletIndex;
        this._llmClient = llmClient;
        this._model = model;
        this._onProgress = onProgress || null;
        this._onModelText = onModelText || null;
    }

    /**
     * Retrieve relevant memory context for a user query.
     *
     * @param {string} query the user's message text
     * @param {string} [conversationText] current session text for reference resolution
     * @returns {Promise<RetrievalResult | null>}
     */
    async retrieveForQuery(query, conversationText) {
        if (!query || !query.trim()) return null;

        const onProgress = this._onProgress;
        const onModelText = this._onModelText;

        onProgress?.({ stage: 'init', message: 'Reading memory index...' });
        await this._backend.init();
        const index = await this._backend.getTree();

        if (!index || await this._isMemoryEmpty(index)) {
            return null;
        }

        let result;
        try {
            onProgress?.({ stage: 'retrieval', message: 'Selecting relevant memory files...' });
            result = await this._toolCallingRetrieval(query, index, onProgress, conversationText, onModelText, { mode: 'retrieve' });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onProgress?.({ stage: 'fallback', message: `LLM unavailable (${message}) — falling back to keyword search. Results may be less accurate.` });
            result = await this._textSearchFallbackWithLoad(query, onProgress, conversationText);
        }

        // Post-filter assembled context to remove facts already in the conversation
        if (result?.assembledContext && conversationText) {
            result.assembledContext = this._filterRedundantContext(result.assembledContext, conversationText);
        }

        return result;
    }

    /**
     * @param {string} query
     * @param {string} index
     * @param {(event: ProgressEvent) => void | null} onProgress
     * @param {string | undefined} conversationText
     * @param {((text: string, iteration: number) => void) | null} onModelText
     * @param {{ mode: 'retrieve' | 'augment' }} options
     * @returns {Promise<RetrievalResult | AugmentQueryResult | null>}
     */
    async _toolCallingRetrieval(query, index, onProgress, conversationText, onModelText, options = { mode: 'retrieve' }) {
        const isAugmentMode = options.mode === 'augment';
        const systemPrompt = (
            RETRIEVAL_SYSTEM_PROMPT.replace('{INDEX}', index) +
            (isAugmentMode ? AUGMENT_SYSTEM_ADDENDUM : '')
        );
        const toolExecutors = {
            ...createRetrievalExecutors(this._backend),
            ...(isAugmentMode ? {
                augment_query: createAugmentQueryExecutor({
                    backend: this._backend,
                    llmClient: this._llmClient,
                    model: this._model,
                    query,
                    conversationText,
                    onProgress: (event) => {
                        if (!event?.stage || !event?.message) return;
                        onProgress?.({
                            stage: event.stage,
                            message: event.message
                        });
                    }
                })
            } : {})
        };
        const tools = isAugmentMode
            ? [
                ...RETRIEVAL_TOOLS.filter((tool) => tool.function.name !== 'assemble_context'),
                AUGMENT_QUERY_TOOL
            ]
            : RETRIEVAL_TOOLS;

        const recentContext = this._buildRecentContext(conversationText);
        const userContent = recentContext
            ? `Recent conversation:\n\`\`\`\n${recentContext}\n\`\`\`\n\nCurrent query: ${query}`
            : query;

        const { terminalToolResult, toolCallLog } = await runAgenticToolLoop({
            llmClient: this._llmClient,
            model: this._model,
            tools,
            toolExecutors,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            terminalTool: isAugmentMode ? 'augment_query' : 'assemble_context',
            maxIterations: isAugmentMode ? 12 : 8,
            maxOutputTokens: 4000,
            temperature: 0,
            executeTerminalTool: isAugmentMode,
            onToolCall: (name, args, result, meta) => {
                const toolState = meta?.status || 'finished';
                let progressArgs = args;
                let progressResult = toolState === 'started' ? '' : (result || '');
                if (toolState === 'finished' && isAugmentMode && name === 'augment_query') {
                    let toolError = '';
                    let noRelevantMemory = false;
                    let canonicalPaths = null;
                    if (typeof result === 'string') {
                        try {
                            const parsed = JSON.parse(result);
                            toolError = typeof parsed?.error === 'string' ? parsed.error : '';
                            noRelevantMemory = parsed?.noRelevantMemory === true;
                            canonicalPaths = Array.isArray(parsed?.files)
                                ? parsed.files
                                    .map((file) => (typeof file?.path === 'string' ? file.path : null))
                                    .filter(Boolean)
                                : null;
                        } catch {
                            toolError = '';
                            canonicalPaths = null;
                        }
                    }

                    if (toolError) {
                        progressResult = `error: ${toolError}`;
                    } else if (noRelevantMemory) {
                        progressResult = 'no relevant memory kept';
                    } else {
                        if (Array.isArray(canonicalPaths) && canonicalPaths.length > 0) {
                            progressArgs = { ...(args || {}), memory_files: canonicalPaths };
                        }
                        const selectedCount = Array.isArray(progressArgs?.memory_files) ? progressArgs.memory_files.length : 0;
                        progressResult = selectedCount === 0
                            ? 'no relevant memory selected'
                            : `crafted augmented prompt from ${selectedCount} file${selectedCount === 1 ? '' : 's'}`;
                    }
                }
                onProgress?.({
                    stage: 'tool_call',
                    message: `Tool: ${name}`,
                    tool: name,
                    args: progressArgs,
                    result: progressResult,
                    toolState,
                    toolCallId: meta?.toolCallId
                });
            },
            onModelText,
            onReasoning: (chunk, iteration) => {
                onProgress?.({ stage: 'reasoning', message: chunk, iteration });
            }
        });

        if (isAugmentMode) {
            let augmentPayload = null;
            try {
                augmentPayload = terminalToolResult?.result
                    ? JSON.parse(terminalToolResult.result)
                    : null;
            } catch {
                augmentPayload = null;
            }

            if (augmentPayload?.noRelevantMemory === true) {
                return null;
            }

            const reviewPrompt = typeof augmentPayload?.reviewPrompt === 'string'
                ? augmentPayload.reviewPrompt
                : '';
            const apiPrompt = typeof augmentPayload?.apiPrompt === 'string'
                ? augmentPayload.apiPrompt
                : MemoryRetriever._stripUserDataTags(reviewPrompt);
            const files = Array.isArray(augmentPayload?.files)
                ? augmentPayload.files.filter((file) => typeof file?.path === 'string' && typeof file?.content === 'string')
                : await collectReadFiles(toolCallLog, this._backend);
            const paths = files.map((file) => file.path);

            if (!reviewPrompt || files.length === 0) return null;

            onProgress?.({
                stage: 'complete',
                message: `Crafted prompt from ${files.length} memory file${files.length === 1 ? '' : 's'}.`,
                paths
            });

            return {
                files,
                paths,
                reviewPrompt,
                apiPrompt
            };
        }

        const files = await collectReadFiles(toolCallLog, this._backend);
        const paths = files.map(f => f.path);

        const assembledContext = terminalToolResult?.arguments?.content || null;

        if (files.length === 0 && !assembledContext) return null;

        const snippetContext = await this._buildSnippetContext(paths, query, conversationText);

        onProgress?.({
            stage: 'complete',
            message: `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}.`,
            paths
        });

        return { files, paths, assembledContext: assembledContext || snippetContext };
    }

    /**
     * @param {string} query
     * @param {string} [conversationText]
     * @returns {Promise<AugmentQueryResult | null>}
     */
    async augmentQueryForPrompt(query, conversationText) {
        if (!query || !query.trim()) return null;

        const onProgress = this._onProgress;
        const onModelText = this._onModelText;

        onProgress?.({ stage: 'init', message: 'Reading memory index...' });
        await this._backend.init();
        const index = await this._backend.getTree();

        if (!index || await this._isMemoryEmpty(index)) {
            return null;
        }

        try {
            onProgress?.({ stage: 'retrieval', message: 'Reading memory and crafting a review prompt...' });
            return /** @type {Promise<AugmentQueryResult | null>} */ (
                this._toolCallingRetrieval(query, index, onProgress, conversationText, onModelText, { mode: 'augment' })
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onProgress?.({ stage: 'fallback', message: `Memory prompt crafting unavailable (${message}).` });
            return null;
        }
    }

    async _textSearchFallbackWithLoad(query, onProgress, conversationText) {
        const paths = await this._textSearchFallback(query);
        if (!paths || paths.length === 0) return null;

        const MAX_PER_FILE_CHARS = 1500;
        const files = [];
        let total = 0;
        for (const path of paths.slice(0, MAX_FILES_TO_LOAD)) {
            onProgress?.({ stage: 'loading', message: `Loading ${path}...`, path });
            const raw = await this._backend.read(path);
            if (!raw) continue;
            const content = raw.length > MAX_PER_FILE_CHARS
                ? raw.slice(0, MAX_PER_FILE_CHARS) + '...(truncated)'
                : raw;
            if (total + content.length > MAX_TOTAL_CONTEXT_CHARS) break;
            files.push({ path, content });
            total += content.length;
        }

        if (files.length === 0) return null;

        const assembled = await this._buildSnippetContext(files.map(f => f.path), query, conversationText);

        onProgress?.({
            stage: 'complete',
            message: `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}.`,
            paths: files.map(f => f.path)
        });

        return { files, paths: files.map(f => f.path), assembledContext: assembled };
    }

    async _textSearchFallback(query) {
        const words = query.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
        const allPaths = new Set();

        for (const word of words) {
            const results = await this._backend.search(word);
            for (const r of results) {
                allPaths.add(r.path);
            }
        }

        return [...allPaths].slice(0, MAX_FILES_TO_LOAD);
    }

    async _buildSnippetContext(paths, query, conversationText) {
        const queryTerms = tokenizeQuery(query);
        let candidates = [];
        const convWords = conversationText
            ? new Set(normalizeFactText(conversationText).split(/\s+/).filter(w => w.length >= 3))
            : null;

        await this._bulletIndex.init();
        const indexed = this._bulletIndex.getBulletsForPaths(paths);

        if (indexed.length === 0) {
            for (const path of paths) {
                await this._bulletIndex.refreshPath(path);
            }
        }

        const indexedAfterRefresh = this._bulletIndex.getBulletsForPaths(paths);
        for (const item of indexedAfterRefresh) {
            const score = scoreBullet(item.bullet, queryTerms);
            candidates.push({
                path: item.path,
                score,
                text: renderBullet(item.bullet),
                updatedAt: item.bullet.updatedAt || '',
                fileUpdatedAt: item.fileUpdatedAt || 0
            });
        }

        // Legacy fallback if a path is still not indexable.
        if (candidates.length === 0) {
            for (const path of paths) {
                const raw = await this._backend.read(path);
                if (!raw) continue;
                const bullets = parseBullets(raw);
                if (bullets.length > 0) {
                    for (const bullet of bullets) {
                        const score = scoreBullet(bullet, queryTerms);
                        candidates.push({ path, score, text: renderBullet(bullet), updatedAt: bullet.updatedAt || '' });
                    }
                    continue;
                }
                for (const snippet of this._scoreRawLines(raw, queryTerms)) {
                    candidates.push({ path, score: snippet.score, text: `- ${snippet.text}`, updatedAt: '' });
                }
            }
        }

        // Filter out bullets already present in the current conversation
        if (convWords && convWords.size > 0) {
            candidates = candidates.filter(c => {
                const factWords = normalizeFactText(c.text).split(/\s+/).filter(w => w.length >= 3);
                if (factWords.length < 2) return true;
                const matchCount = factWords.filter(w => convWords.has(w)).length;
                return matchCount / factWords.length < 0.8;
            });
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        });

        const selected = candidates.slice(0, MAX_SNIPPETS);
        const grouped = new Map();
        for (const item of selected) {
            const list = grouped.get(item.path) || [];
            list.push(item.text);
            grouped.set(item.path, list);
        }

        let total = 0;
        const sections = [];
        for (const [path, lines] of grouped.entries()) {
            const section = `### ${path}\n${lines.join('\n')}`;
            if (total + section.length > MAX_TOTAL_CONTEXT_CHARS) break;
            sections.push(section);
            total += section.length;
        }

        return sections.join('\n\n').trim() || null;
    }

    _filterRedundantContext(assembledContext, conversationText) {
        const convWords = new Set(
            normalizeFactText(conversationText).split(/\s+/).filter(w => w.length >= 3)
        );
        if (convWords.size === 0) return assembledContext;

        const lines = assembledContext.split('\n');
        const filtered = lines.filter(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('-')) return true;
            const factWords = normalizeFactText(trimmed).split(/\s+/).filter(w => w.length >= 3);
            if (factWords.length < 2) return true;
            const matchCount = factWords.filter(w => convWords.has(w)).length;
            return matchCount / factWords.length < 0.8;
        });

        const result = filtered.join('\n').trim();
        return result || null;
    }

    _scoreRawLines(content, queryTerms) {
        const lines = String(content || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !line.startsWith('#'));
        if (lines.length === 0) return [];

        const snippets = lines.map((line) => {
            const lower = line.toLowerCase();
            let score = 0;
            for (const term of queryTerms) {
                if (lower.includes(term)) score += 1;
            }
            return { text: line, score };
        });

        snippets.sort((a, b) => b.score - a.score);
        return snippets.slice(0, 5);
    }

    _buildRecentContext(conversationText) {
        return trimRecentConversation(conversationText, {
            maxChars: MAX_RECENT_CONTEXT_CHARS
        });
    }

    async _isMemoryEmpty(index) {
        const all = await this._backend.exportAll();
        const realFiles = all.filter(f => !f.path.endsWith('_tree.md'));
        if (realFiles.length === 0) return true;
        return !realFiles.some(f => (f.itemCount || 0) > 0);
    }

    static _stripUserDataTags(text) {
        if (!text) return text;
        return text.replace(/\[\[user_data\]\]/g, '').replace(/\[\[\/user_data\]\]/g, '');
    }
}

export { MemoryRetriever };

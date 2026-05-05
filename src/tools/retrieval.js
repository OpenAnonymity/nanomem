/**
 * MemoryRetriever — Read path for agentic memory.
 *
 * Uses tool-calling via the agentic loop to let the LLM search, read,
 * and assemble relevant memory context. Falls back to brute-force text
 * search if the LLM call fails.
 */
/** @import { LLMClient, Message, ProgressEvent, RetrievalResult, AugmentQueryResult, StorageBackend, ToolDefinition } from '../types.js' */
import { runAgenticToolLoop } from '../internal/toolLoop.js';
import { craftAugmentedPromptFromFiles, createAugmentQueryExecutor, createRetrievalExecutors } from './executors.js';
import { trimRecentConversation } from '../internal/recentConversation.js';
import {
    retrievalPrompt,
    augmentAddendum,
    adaptiveRetrievalPrompt
} from '../prompts/retrieval.js';
import {
    normalizeFactText,
    parseBullets,
    renderBullet,
    scoreBullet,
    tokenizeQuery
} from '../internal/format/index.js';

const MAX_FILES_TO_LOAD = 8;
const MAX_TOTAL_CONTEXT_CHARS = 4000;
const MAX_SNIPPETS = 18;
const MAX_RECENT_CONTEXT_CHARS = 2000;
const MAX_DISPLAY_CONTEXT_CHARS = 2500;
const REDUNDANT_CONTEXT_MIN_TOKENS = 4;
const REDUNDANT_CONTEXT_OVERLAP_THRESHOLD = 0.82;
const ADAPTIVE_FALLBACK_STOPWORDS = new Set([
    'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
    'have', 'has', 'had', 'with', 'from', 'into', 'onto', 'about', 'there',
    'their', 'them', 'they', 'those', 'these', 'this', 'that', 'your', 'yours',
    'project', 'projects', 'deadline', 'deadlines', 'current', 'currently',
    'main', 'more', 'focus', 'using', 'built', 'typical', 'stack', 'recipe',
    'recipes', 'alpha', 'launch', 'app', 'apps'
]);

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
            name: 'search_memory',
            description: 'Search memory by keyword. Returns matching files with their file paths AND the matching bullet lines from each file (lines include stored metadata like tier and updated_at). The bullet lines are usually all you need to answer the query — but if you want to see the full file, you can pass the returned path to read_file. Use ONE short keyword per call (e.g. "yoga", "Berkeley", "cooking") — call search_memory again with a different keyword if you need more.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Single short keyword to search for (e.g. "yoga", "Berkeley", "cooking"). Multi-word phrases are matched as literal substrings, so prefer one keyword at a time and call again for additional terms.' }
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

const RETRIEVAL_SYSTEM_PROMPT = retrievalPrompt.replace('{MAX_FILES}', String(MAX_FILES_TO_LOAD));

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

const AUGMENT_SYSTEM_ADDENDUM = augmentAddendum;

/** @type {ToolDefinition[]} */
const ADAPTIVE_RETRIEVAL_TOOLS = RETRIEVAL_TOOLS.map(tool => {
    if (tool.function.name !== 'assemble_context') return tool;
    return {
        type: 'function',
        function: {
            name: 'assemble_context',
            description: tool.function.description +
                ' When skipping because existing context already covers the query, set skipped=true and provide a skip_reason instead of fetching any files.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'Newly retrieved facts as synthesized prose. Empty string when skipped.' },
                    skipped: { type: 'boolean', description: 'True when existing context already covers the query and no new retrieval was done.' },
                    skip_reason: { type: 'string', description: 'Brief explanation of why retrieval was skipped. Required when skipped=true.' }
                },
                required: ['content']
            }
        }
    };
});

const MAX_ALREADY_RETRIEVED_CHARS = 3000;

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
            maxIterations: isAugmentMode ? 12 : 10,
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
                apiPrompt,
                assembledContext: null
            };
        }

        const files = await collectReadFiles(toolCallLog, this._backend);
        const paths = files.map(f => f.path);

        const terminalWasCalled = terminalToolResult != null;
        const assembledContext = terminalToolResult?.arguments?.content || null;

        // LLM explicitly said nothing relevant — respect that, don't fall back to snippet context.
        if (terminalWasCalled && !assembledContext) return null;

        if (files.length === 0 && !assembledContext) return null;

        const snippetContext = terminalWasCalled ? null : await this._buildSnippetContext(paths, query, conversationText);

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
            onProgress?.({ stage: 'retrieval', message: 'Retrieving memory...' });
            return /** @type {Promise<AugmentQueryResult | null>} */ (
                this._toolCallingRetrieval(query, index, onProgress, conversationText, onModelText, { mode: 'augment' })
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onProgress?.({ stage: 'fallback', message: `Memory prompt crafting unavailable (${message}).` });
            return null;
        }
    }

    /**
     * Build a reviewable prompt for a multi-turn session, only crafting a prompt
     * when adaptive retrieval finds memory not already delivered earlier.
     *
     * @param {string} query
     * @param {string} [alreadyRetrievedContext]
     * @param {string} [conversationText]
     * @returns {Promise<import('../types.js').AdaptiveAugmentQueryResult | null>}
     */
    async augmentQueryAdaptively(query, alreadyRetrievedContext, conversationText) {
        if (!query || !query.trim()) return null;

        if (!alreadyRetrievedContext || !alreadyRetrievedContext.trim()) {
            const result = await this.augmentQueryForPrompt(query, conversationText);
            return result ? { ...result, skipped: false } : null;
        }

        const retrieval = await this.retrieveAdaptively(query, alreadyRetrievedContext, conversationText);
        if (!retrieval) return null;
        if (retrieval.skipped) {
            return {
                files: [],
                paths: [],
                reviewPrompt: null,
                apiPrompt: null,
                assembledContext: null,
                skipped: true,
                skipReason: retrieval.skipReason || 'Already covered by retrieved context.',
                ...(retrieval.displayText ? { displayText: retrieval.displayText } : {})
            };
        }

        const assembledContext = typeof retrieval.assembledContext === 'string'
            ? retrieval.assembledContext.trim()
            : '';
        if (!assembledContext) {
            return {
                files: [],
                paths: [],
                reviewPrompt: null,
                apiPrompt: null,
                assembledContext: null,
                skipped: true,
                skipReason: 'No new relevant memory found.'
            };
        }

        const paths = Array.isArray(retrieval.paths) ? retrieval.paths : [];
        const syntheticPath = paths.length > 0
            ? `adaptive/new-context-from-${paths.join('__').slice(0, 120)}`
            : 'adaptive/new-context.md';
        const crafted = await craftAugmentedPromptFromFiles({
            llmClient: this._llmClient,
            model: this._model,
            query,
            files: [{ path: syntheticPath, content: assembledContext }],
            conversationText,
            onProgress: (event) => {
                if (!event?.stage || !event?.message) return;
                this._onProgress?.({
                    stage: event.stage,
                    message: event.message
                });
            }
        });

        if (crafted.error) {
            this._onProgress?.({ stage: 'fallback', message: `Adaptive prompt crafting unavailable (${crafted.error}).` });
            return null;
        }

        if (crafted.noRelevantMemory || !crafted.reviewPrompt || !crafted.apiPrompt) {
            return {
                files: [],
                paths: [],
                reviewPrompt: null,
                apiPrompt: null,
                assembledContext: null,
                skipped: true,
                skipReason: 'No new memory context needed.'
            };
        }

        return {
            files: Array.isArray(retrieval.files) ? retrieval.files : [],
            paths,
            reviewPrompt: crafted.reviewPrompt,
            apiPrompt: crafted.apiPrompt,
            assembledContext,
            skipped: false
        };
    }

    async _textSearchFallbackWithLoad(query, onProgress, conversationText) {
        const paths = await this._textSearchFallback(query);
        if (!paths || paths.length === 0) return null;

        const MAX_PER_FILE_CHARS = 10000;
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
        const displayText = assembled
            ? await this._renderDirectAnswer(query, assembled)
            : null;

        onProgress?.({
            stage: 'complete',
            message: `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}.`,
            paths: files.map(f => f.path)
        });

        return {
            files,
            paths: files.map(f => f.path),
            assembledContext: assembled,
            ...(displayText ? { displayText } : {})
        };
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

    _buildAdaptiveFallbackQuery(query, alreadyRetrievedContext) {
        const baseTerms = tokenizeQuery(query);
        if (!alreadyRetrievedContext || !alreadyRetrievedContext.trim()) {
            return query;
        }

        const hasReferentialLanguage = /\b(it|its|they|them|their|that|those|these|this|same|former|latter)\b/i.test(query);
        const hasSpecificTerms = baseTerms.some((term) => !ADAPTIVE_FALLBACK_STOPWORDS.has(term));
        if (!hasReferentialLanguage && hasSpecificTerms) {
            return query;
        }

        const candidates = [];
        const seen = new Set(baseTerms);
        const pushCandidate = (raw) => {
            const token = String(raw || '').trim();
            if (!token) return;
            const normalized = token.toLowerCase();
            if (normalized.length < 3) return;
            if (ADAPTIVE_FALLBACK_STOPWORDS.has(normalized)) return;
            if (seen.has(normalized)) return;
            seen.add(normalized);
            candidates.push(token);
        };

        for (const match of alreadyRetrievedContext.matchAll(/\*\*([^*]+)\*\*/g)) {
            const phrase = match[1]?.trim();
            if (!phrase) continue;
            for (const token of phrase.split(/[^A-Za-z0-9_-]+/)) {
                pushCandidate(token);
            }
        }

        for (const match of alreadyRetrievedContext.matchAll(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g)) {
            pushCandidate(match[0]);
        }

        if (candidates.length === 0) {
            return query;
        }

        return `${query} ${candidates.slice(0, 6).join(' ')}`.trim();
    }

    async _renderDirectAnswer(query, sourceContext) {
        const context = String(sourceContext || '').trim();
        if (!context) return null;

        const truncated = context.length > MAX_DISPLAY_CONTEXT_CHARS
            ? context.slice(0, MAX_DISPLAY_CONTEXT_CHARS) + '...(truncated)'
            : context;

        try {
            const response = await this._llmClient.createChatCompletion({
                model: this._model,
                messages: [
                    {
                        role: 'system',
                        content: 'Answer the user in concise plain prose using only the provided memory context. Do not mention files, bullets, retrieval, or metadata. If the context does not answer the question, reply with an empty string.'
                    },
                    {
                        role: 'user',
                        content: `Memory context:\n\`\`\`\n${truncated}\n\`\`\`\n\nQuestion: ${query}`
                    }
                ],
                max_tokens: 250,
                temperature: 0
            });

            const text = String(response?.content || '').trim();
            return text || this._fallbackDisplayText(query, context);
        } catch {
            return this._fallbackDisplayText(query, context);
        }
    }

    _fallbackDisplayText(query, sourceContext) {
        const context = String(sourceContext || '').trim();
        if (!context) return null;
        const queryText = String(query || '').toLowerCase();
        const blocks = this._splitContextBlocks(context);

        if (/\bdeadline|deadlines|launch|due\b/.test(queryText)) {
            const entryAnswer = this._summarizeEntryDeadlines(blocks);
            if (entryAnswer) return entryAnswer;
        }

        const cleanedLines = blocks.flatMap((block) => block.lines);
        if (cleanedLines.length === 0) return null;

        if (/\bdeadline|deadlines|launch|due\b/.test(queryText)) {
            const relevant = cleanedLines.filter((line) => /\bdeadline|deadlines|launch|due|alpha\b/i.test(line));
            if (relevant.length > 0) return relevant.join('\n\n');
        }

        if (/\bpets?\b/.test(queryText)) {
            const possession = cleanedLines.find((line) => /^- Has\s+/i.test(line));
            if (possession) {
                return possession
                    .replace(/^- Has\s+/i, 'You have ')
                    .replace(/\s*$/, '.');
            }
        }

        const bulletLines = cleanedLines.filter((line) => line.startsWith('- '));
        if (bulletLines.length > 0) {
            return bulletLines.join('\n');
        }

        return cleanedLines.join('\n\n');
    }

    _splitContextBlocks(text) {
        return String(text || '')
            .split(/\n\s*\n/)
            .map((block) => block.trim())
            .filter(Boolean)
            .map((block) => ({
                raw: block,
                lines: block
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .filter((line) => !line.startsWith('### '))
                    .map((line) => line.replace(/\s+\|\s+.*$/, ''))
            }))
            .filter((block) => block.lines.length > 0);
    }

    _summarizeEntryDeadlines(blocks) {
        const entries = blocks
            .map(({ lines }) => {
                const paragraph = lines.join(' ').trim();
                const match = /^\*\*([^*]+)\*\*\s+[—-]\s+([\s\S]+)$/.exec(paragraph);
                if (!match) return null;
                return {
                    name: match[1].trim(),
                    text: match[2].trim()
                };
            })
            .filter(Boolean);

        if (entries.length === 0) return null;

        const summaries = entries.map(({ name, text }) => {
            const deadlineMatch = /\b(?:deadline|launch deadline)\s+of\s+([^.,;]+)/i.exec(text)
                || /\bdue\s+(?:on\s+)?([^.,;]+)/i.exec(text)
                || /\blaunch(?:ing)?\s+(?:on\s+)?([^.,;]+)/i.exec(text);

            if (deadlineMatch) {
                return `${name} has a deadline of ${deadlineMatch[1].trim()}.`;
            }

            return `No specific deadline is mentioned for ${name}.`;
        });

        return summaries.join('\n\n');
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

    /**
     * Adaptive retrieval for multi-turn sessions. Looks at the current query plus
     * memory context already delivered in this session and only retrieves if
     * something genuinely new is needed. Returns an AdaptiveRetrievalResult that
     * is never null — when retrieval is skipped, skipped=true and skipReason explains why.
     *
     * @param {string} query - the user's current message
     * @param {string} [alreadyRetrievedContext] - memory context already in the session
     * @param {string} [conversationText] - recent conversation for reference resolution
     * @returns {Promise<import('../types.js').AdaptiveRetrievalResult | null>}
     */
    async retrieveAdaptively(query, alreadyRetrievedContext, conversationText) {
        if (!query || !query.trim()) return null;

        const onProgress = this._onProgress;
        const onModelText = this._onModelText;

        // No prior context → plain retrieval, wrapped in the adaptive result shape.
        if (!alreadyRetrievedContext || !alreadyRetrievedContext.trim()) {
            onProgress?.({ stage: 'init', message: 'Reading memory index...' });
            await this._backend.init();
            const index = await this._backend.getTree();
            if (!index || await this._isMemoryEmpty(index)) return null;

            try {
                onProgress?.({ stage: 'retrieval', message: 'Selecting relevant memory files...' });
                const result = await this._toolCallingRetrieval(query, index, onProgress, conversationText, onModelText, { mode: 'retrieve' });
                if (!result) return null;
                return { ...result, skipped: false };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                onProgress?.({ stage: 'fallback', message: `LLM unavailable (${message}) — falling back to keyword search.` });
                const fallback = await this._textSearchFallbackWithLoad(query, onProgress, conversationText);
                return fallback ? { ...fallback, skipped: false } : null;
            }
        }

        onProgress?.({ stage: 'init', message: 'Reading memory index...' });
        await this._backend.init();
        const index = await this._backend.getTree();
        if (!index || await this._isMemoryEmpty(index)) return null;

        let result;
        try {
            onProgress?.({ stage: 'retrieval', message: 'Checking existing memory context...' });
            result = await this._adaptiveToolCallingRetrieval(query, index, onProgress, conversationText, onModelText, alreadyRetrievedContext);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onProgress?.({ stage: 'fallback', message: `Adaptive retrieval unavailable (${message}) — falling back to keyword search.` });
            const expandedQuery = this._buildAdaptiveFallbackQuery(query, alreadyRetrievedContext);
            const fallback = await this._textSearchFallbackWithLoad(expandedQuery, onProgress, conversationText);
            if (fallback) return { ...fallback, skipped: false };
            return {
                files: [],
                paths: [],
                assembledContext: null,
                skipped: true,
                skipReason: 'No new relevant memory found.'
            };
        }

        if (!result) {
            return {
                files: [],
                paths: [],
                assembledContext: null,
                skipped: true,
                skipReason: 'No new relevant memory found.'
            };
        }

        if (result && !result.skipped && result.assembledContext && conversationText) {
            result.assembledContext = this._filterRedundantContext(result.assembledContext, conversationText);
        }

        return result;
    }

    async _adaptiveToolCallingRetrieval(query, index, onProgress, conversationText, onModelText, alreadyRetrievedContext) {
        const truncatedRetrieved = alreadyRetrievedContext.length > MAX_ALREADY_RETRIEVED_CHARS
            ? alreadyRetrievedContext.slice(0, MAX_ALREADY_RETRIEVED_CHARS) + '...(truncated)'
            : alreadyRetrievedContext;

        const systemPrompt = adaptiveRetrievalPrompt
            .replace('{INDEX}', index)
            .replace('{ALREADY_RETRIEVED}', truncatedRetrieved)
            .replace('{MAX_FILES}', String(MAX_FILES_TO_LOAD));

        const toolExecutors = createRetrievalExecutors(this._backend);

        const recentContext = this._buildRecentContext(conversationText);
        const userContent = recentContext
            ? `Recent conversation:\n\`\`\`\n${recentContext}\n\`\`\`\n\nCurrent query: ${query}`
            : query;

        const { terminalToolResult, toolCallLog } = await runAgenticToolLoop({
            llmClient: this._llmClient,
            model: this._model,
            tools: ADAPTIVE_RETRIEVAL_TOOLS,
            toolExecutors,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            terminalTool: 'assemble_context',
            maxIterations: 10,
            maxOutputTokens: 4000,
            temperature: 0,
            onToolCall: (name, args, result, meta) => {
                const toolState = meta?.status || 'finished';
                const progressResult = toolState === 'started' ? '' : (result || '');
                onProgress?.({
                    stage: 'tool_call',
                    message: `Tool: ${name}`,
                    tool: name,
                    args,
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

        const args = terminalToolResult?.arguments || {};

        // LLM explicitly signalled skip
        if (args.skipped === true) {
            const skipReason = args.skip_reason || 'Already covered by retrieved context.';
            const displayText = await this._renderDirectAnswer(query, alreadyRetrievedContext);
            onProgress?.({ stage: 'complete', message: `Retrieval skipped: ${skipReason}` });
            return {
                files: [],
                paths: [],
                assembledContext: null,
                skipped: true,
                skipReason,
                ...(displayText ? { displayText } : {})
            };
        }

        const files = await collectReadFiles(toolCallLog, this._backend);
        const paths = files.map(f => f.path);
        const assembledContext = args.content || null;

        // Terminal was called but nothing new was found
        if (terminalToolResult && !assembledContext) {
            const reason = 'No new relevant memory found.';
            const displayText = await this._renderDirectAnswer(query, alreadyRetrievedContext);
            onProgress?.({ stage: 'complete', message: `Retrieval skipped: ${reason}` });
            return {
                files: [],
                paths: [],
                assembledContext: null,
                skipped: true,
                skipReason: reason,
                ...(displayText ? { displayText } : {})
            };
        }

        if (files.length === 0 && !assembledContext) {
            const reason = 'No new relevant memory found.';
            const displayText = await this._renderDirectAnswer(query, alreadyRetrievedContext);
            onProgress?.({ stage: 'complete', message: `Retrieval skipped: ${reason}` });
            return {
                files: [],
                paths: [],
                assembledContext: null,
                skipped: true,
                skipReason: reason,
                ...(displayText ? { displayText } : {})
            };
        }

        const snippetContext = terminalToolResult ? null : await this._buildSnippetContext(paths, query, conversationText);

        onProgress?.({
            stage: 'complete',
            message: `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}.`,
            paths
        });

        const finalContext = assembledContext || snippetContext;
        if (this._isContextRedundant(finalContext, alreadyRetrievedContext)) {
            const skipReason = 'Already covered by retrieved context.';
            const displayText = await this._renderDirectAnswer(query, alreadyRetrievedContext);
            onProgress?.({ stage: 'complete', message: `Retrieval skipped: ${skipReason}` });
            return {
                files: [],
                paths: [],
                assembledContext: null,
                skipped: true,
                skipReason,
                ...(displayText ? { displayText } : {})
            };
        }

        const displayText = snippetContext && !assembledContext
            ? await this._renderDirectAnswer(query, snippetContext)
            : null;

        return {
            files,
            paths,
            assembledContext: finalContext,
            skipped: false,
            ...(displayText ? { displayText } : {})
        };
    }

    _isContextRedundant(candidateContext, alreadyRetrievedContext) {
        const candidateTokens = new Set(tokenizeQuery(candidateContext || ''));
        const existingTokens = new Set(tokenizeQuery(alreadyRetrievedContext || ''));
        if (candidateTokens.size < REDUNDANT_CONTEXT_MIN_TOKENS || existingTokens.size === 0) {
            return false;
        }

        let overlap = 0;
        for (const token of candidateTokens) {
            if (existingTokens.has(token)) overlap += 1;
        }

        return overlap / candidateTokens.size >= REDUNDANT_CONTEXT_OVERLAP_THRESHOLD;
    }

    static _stripUserDataTags(text) {
        if (!text) return text;
        return text.replace(/\[\[user_data\]\]/g, '').replace(/\[\[\/user_data\]\]/g, '');
    }
}

export { MemoryRetriever };

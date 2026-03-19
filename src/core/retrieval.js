/**
 * MemoryRetrieval — Read path for agentic memory.
 *
 * Uses tool-calling via the agentic loop to let the LLM search, read,
 * and assemble relevant memory context. Falls back to brute-force text
 * search if the LLM call fails.
 */
import { runAgenticToolLoop } from './toolLoop.js';
import { createRetrievalExecutors } from '../storage/interface.js';
import {
    normalizeFactText,
    parseMemoryBullets,
    renderMemoryBullet,
    scoreMemoryBullet,
    tokenizeQuery
} from '../bullets/utils.js';

const MAX_FILES_TO_LOAD = 8;
const MAX_TOTAL_CONTEXT_CHARS = 4000;
const MAX_SNIPPETS = 18;
const MAX_RECENT_CONTEXT_CHARS = 2000;
const FAST_DOMAIN_HINTS = [
    { dir: 'health', terms: ['allergy', 'allergies', 'health', 'medical', 'medicine', 'medication', 'symptom', 'condition'] },
    { dir: 'pets', terms: ['pet', 'pets', 'cat', 'dog', 'animal'] },
    { dir: 'work', terms: ['work', 'job', 'career', 'role', 'team', 'tech', 'stack', 'typescript', 'postgresql', 'backend'] },
    { dir: 'personal', terms: ['live', 'location', 'family', 'personal', 'background'] },
    { dir: 'preferences', terms: ['prefer', 'preference', 'style', 'favorite', 'diet'] },
];

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
            name: 'append_mem_to_query',
            description: 'Assemble the final memory context to attach to the user query. Call this when done selecting and reading files. The content you provide will be used as context for answering the user message.',
            parameters: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'The assembled memory context to attach to the query. Include relevant excerpts from the files you read.' }
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
5. When you've found relevant context, call append_mem_to_query with curated excerpts.
6. If nothing is relevant, call append_mem_to_query with an empty string.

IMPORTANT — Domain-exhaustive retrieval:
- For health, medicine, or medical queries: read ALL files in health/. Every health condition is potentially relevant to medication, treatment, or wellness questions — even if the file description does not mention "medication" explicitly.
- For family-related queries: check personal/family.md AND any health files about family members.
- More generally: when a query touches a domain (health, work, personal), prefer completeness over selectivity within that domain. File descriptions may be incomplete — a file about "narcolepsy" is relevant to a "what medicine should I buy" query even though neither word appears in the other.

When recent conversation context is provided alongside the query, use it to resolve references like "that", "the same", "what we discussed", etc. The conversation shows what the user has been talking about recently.

Only include content that genuinely helps answer this specific query. Do not include unrelated files from other domains.`;


class MemoryRetrieval {
    constructor({ backend, bulletIndex, llmClient, model }) {
        this._backend = backend;
        this._bulletIndex = bulletIndex;
        this._llmClient = llmClient;
        this._model = model;
    }

    /**
     * Retrieve relevant memory context for a user query.
     * @param {string} query — the user's message text
     * @param {object} [options]
     * @param {Function} [options.onProgress] — progress callback
     * @param {string} [options.conversationText] — current session text to filter out redundant facts
     * @param {Function} [options.onModelText] — callback for intermediate model text
     * @param {AbortSignal} [options.signal] — cancellation signal
     * @returns {Promise<{files: {path: string, content: string}[], paths: string[], assembledContext: string|null}|null>}
     */
    async retrieveForQuery(query, options = {}) {
        if (!query || !query.trim()) return null;

        const { onProgress, conversationText, onModelText, signal } = options;

        try {
            onProgress?.({ stage: 'init', message: 'Reading memory index...' });
            await this._backend.init();
            const index = await this._backend.getIndex();

            if (!index || await this._isTrivialIndex(index)) {
                return null;
            }

            let result;
            try {
                const quickResult = await this._quickDomainRetrieval(query, onProgress, conversationText);
                if (quickResult) {
                    return quickResult;
                }

                // Try LLM-driven retrieval
                onProgress?.({ stage: 'retrieval', message: 'Selecting relevant memory files...' });
                result = await this._toolCallingRetrieval(query, index, onProgress, conversationText, onModelText, signal);
            } catch (err) {
                // Fallback: brute-force text search
                onProgress?.({ stage: 'retrieval', message: 'LLM unavailable, using fallback text search...' });
                result = await this._textSearchFallbackWithLoad(query, onProgress, conversationText);
            }

            // Post-filter assembled context to remove facts already in the conversation
            if (result?.assembledContext && conversationText) {
                result.assembledContext = this._filterRedundantContext(result.assembledContext, conversationText);
            }

            return result;

        } catch (error) {
            return null;
        }
    }

    async _toolCallingRetrieval(query, index, onProgress, conversationText, onModelText, signal) {
        const systemPrompt = RETRIEVAL_SYSTEM_PROMPT.replace('{INDEX}', index);
        const toolExecutors = createRetrievalExecutors(this._backend);

        // Include recent conversation context so the retrieval LLM can resolve
        // references in follow-up queries (e.g. "tell me more about that")
        const recentContext = this._buildRecentContext(conversationText);
        const userContent = recentContext
            ? `Recent conversation:\n\`\`\`\n${recentContext}\n\`\`\`\n\nCurrent query: ${query}`
            : query;

        const { terminalToolResult, toolCallLog, iterations } = await runAgenticToolLoop({
            llmClient: this._llmClient,
            model: this._model,
            tools: RETRIEVAL_TOOLS,
            toolExecutors,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent }
            ],
            terminalTool: 'append_mem_to_query',
            maxIterations: 8,
            maxOutputTokens: 500,
            temperature: 0,
            onToolCall: (name, args, result) => {
                onProgress?.({ stage: 'tool_call', message: `Tool: ${name}`, tool: name, args, result });
            },
            onModelText,
            onReasoning: (chunk, iteration) => {
                onProgress?.({ stage: 'reasoning', message: chunk, iteration });
            },
            signal
        });

        // Build files list from read_file calls in the log
        const files = [];
        const seenPaths = new Set();
        for (const entry of toolCallLog) {
            if (entry.name === 'read_file' && entry.args?.path && entry.result) {
                const path = entry.args.path;
                if (seenPaths.has(path)) continue;
                try {
                    const parsed = JSON.parse(entry.result);
                    if (parsed.error) continue;
                } catch { /* not JSON, it's file content */ }
                seenPaths.add(path);
                files.push({ path, content: entry.result });
            }
        }

        const assembledContext = terminalToolResult?.arguments?.content || null;
        const paths = files.map(f => f.path);

        if (files.length === 0 && !assembledContext) return null;

        // Build snippet-level context using bullet index for the approval UI
        const snippetContext = await this._buildSnippetContext(paths, query, conversationText);

        onProgress?.({
            stage: 'complete',
            message: `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'}.`,
            paths
        });

        return { files, paths, assembledContext: assembledContext || snippetContext };
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

        // Build snippet-level assembled context from fallback
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

    async _quickDomainRetrieval(query, onProgress, conversationText) {
        const queryLower = String(query || '').toLowerCase();
        const matchedDirs = FAST_DOMAIN_HINTS
            .filter(({ terms }) => terms.some((term) => queryLower.includes(term)))
            .map(({ dir }) => dir);

        if (matchedDirs.length === 0) return null;

        const allFiles = await this._backend.exportAll();
        const paths = allFiles
            .filter((file) => !file.path.endsWith('_index.md'))
            .map((file) => file.path)
            .filter((path) => matchedDirs.some((dir) => path === dir || path.startsWith(`${dir}/`)))
            .slice(0, MAX_FILES_TO_LOAD);

        if (paths.length === 0) return null;

        onProgress?.({ stage: 'retrieval', message: 'Using fast local retrieval...', paths });

        const files = [];
        for (const path of paths) {
            const raw = await this._backend.read(path);
            if (!raw) continue;
            files.push({ path, content: raw.length > 1500 ? raw.slice(0, 1500) + '...(truncated)' : raw });
        }

        if (files.length === 0) return null;

        const assembledContext = await this._buildSnippetContext(paths, query, conversationText);
        if (!assembledContext) return null;

        onProgress?.({
            stage: 'complete',
            message: `Retrieved ${files.length} memory file${files.length === 1 ? '' : 's'} via fast path.`,
            paths
        });

        return { files, paths, assembledContext };
    }

    async _buildSnippetContext(paths, query, conversationText) {
        const queryTerms = tokenizeQuery(query);
        let candidates = [];
        const convWords = conversationText
            ? new Set(normalizeFactText(conversationText).split(/\s+/).filter(w => w.length >= 3))
            : null;

        await this._bulletIndex.init();
        const indexed = this._bulletIndex.getBulletsForPaths(paths);

        // Keep a safe fallback for first-run races.
        if (indexed.length === 0) {
            for (const path of paths) {
                await this._bulletIndex.refreshPath(path);
            }
        }

        const indexedAfterRefresh = this._bulletIndex.getBulletsForPaths(paths);
        for (const item of indexedAfterRefresh) {
            const score = scoreMemoryBullet(item.bullet, queryTerms);
            candidates.push({
                path: item.path,
                score,
                text: renderMemoryBullet(item.bullet),
                updatedAt: item.bullet.updatedAt || '',
                fileUpdatedAt: item.fileUpdatedAt || 0
            });
        }

        // Legacy fallback if a path is still not indexable.
        if (candidates.length === 0) {
            for (const path of paths) {
                const raw = await this._backend.read(path);
                if (!raw) continue;
                const bullets = parseMemoryBullets(raw);
                if (bullets.length > 0) {
                    for (const bullet of bullets) {
                        const score = scoreMemoryBullet(bullet, queryTerms);
                        candidates.push({ path, score, text: renderMemoryBullet(bullet), updatedAt: bullet.updatedAt || '' });
                    }
                    continue;
                }
                for (const snippet of this._extractLegacySnippets(raw, queryTerms)) {
                    candidates.push({ path, score: snippet.score, text: `- ${snippet.text}`, updatedAt: '' });
                }
            }
        }

        // Filter out bullets whose content is already in the current conversation
        if (convWords && convWords.size > 0) {
            candidates = candidates.filter(c => {
                const factWords = normalizeFactText(c.text).split(/\s+/).filter(w => w.length >= 3);
                if (factWords.length < 2) return true; // Too short to judge
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

    /**
     * Remove lines from assembled context whose key terms already appear in the conversation.
     */
    _filterRedundantContext(assembledContext, conversationText) {
        const convWords = new Set(
            normalizeFactText(conversationText).split(/\s+/).filter(w => w.length >= 3)
        );
        if (convWords.size === 0) return assembledContext;

        const lines = assembledContext.split('\n');
        const filtered = lines.filter(line => {
            const trimmed = line.trim();
            // Keep headings, empty lines, and non-bullet lines
            if (!trimmed || trimmed.startsWith('#') || !trimmed.startsWith('-')) return true;
            const factWords = normalizeFactText(trimmed).split(/\s+/).filter(w => w.length >= 3);
            if (factWords.length < 2) return true;
            const matchCount = factWords.filter(w => convWords.has(w)).length;
            return matchCount / factWords.length < 0.8;
        });

        const result = filtered.join('\n').trim();
        return result || null;
    }

    _extractLegacySnippets(content, queryTerms) {
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
        if (!conversationText || conversationText.length < 20) return null;
        if (conversationText.length <= MAX_RECENT_CONTEXT_CHARS) {
            const hasMultipleTurns = /\n/.test(conversationText.trim());
            return hasMultipleTurns ? conversationText : null;
        }
        let tail = conversationText.slice(-MAX_RECENT_CONTEXT_CHARS);
        const firstNewline = tail.indexOf('\n');
        if (firstNewline > 0 && firstNewline < 200) {
            tail = tail.slice(firstNewline + 1);
        }
        return tail.trim() || null;
    }

    async _isTrivialIndex(index) {
        const all = await this._backend.exportAll();
        const realFiles = all.filter(f => !f.path.endsWith('_index.md'));
        if (realFiles.length === 0) return true;
        return !realFiles.some(f => (f.itemCount || 0) > 0);
    }

}

export { MemoryRetrieval };

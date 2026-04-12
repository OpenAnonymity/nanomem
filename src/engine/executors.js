/**
 * Tool executor factories — the bridge between the agentic tool loop and storage.
 *
 * Architecture:
 *   retrieval.js / extractor.js  — define tool schemas (what the LLM sees)
 *   executors.js (this file)     — implement those tools (what runs when called)
 *   toolLoop.js                  — generic engine that connects the two
 *
 * Each factory takes a storage backend and returns an object mapping
 * tool names to async functions: { tool_name: async (args) => resultString }
 */
/** @import { ChatCompletionResponse, ExtractionExecutorHooks, LLMClient, StorageBackend, ToolDefinition } from '../types.js' */
import {
    compactBullets,
    inferTopicFromPath,
    normalizeFactText,
    parseBullets,
    renderCompactedDocument,
} from '../bullets/index.js';
import { trimRecentConversation } from './recentConversation.js';

const MAX_AUGMENT_QUERY_FILES = 8;
const MAX_AUGMENT_FILE_CHARS = 1800;
const MAX_AUGMENT_TOTAL_CHARS = 12000;
const MAX_AUGMENT_RECENT_CONTEXT_CHARS = 3000;
const AUGMENT_CRAFTER_MAX_ATTEMPTS = 3;
const AUGMENT_CRAFTER_RETRY_BASE_DELAY_MS = 350;

function normalizeLookupPath(value, { stripExtension = false } = {}) {
    let normalized = String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/');

    if (stripExtension) {
        normalized = normalized.replace(/\.md$/i, '');
    }

    if (typeof normalized.normalize === 'function') {
        normalized = normalized.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    }

    return normalizeFactText(normalized.replace(/[\/_]/g, ' '));
}

function pathMatchesQuery(path, query) {
    const rawPath = String(path || '');
    const rawQuery = String(query || '').trim().toLowerCase();
    if (!rawPath || !rawQuery) return false;
    if (rawPath.toLowerCase().includes(rawQuery)) return true;

    const normalizedQuery = normalizeFactText(rawQuery);
    if (!normalizedQuery) return false;

    return normalizeLookupPath(rawPath).includes(normalizedQuery)
        || normalizeLookupPath(rawPath, { stripExtension: true }).includes(normalizedQuery);
}

const AUGMENT_QUERY_EXECUTOR_SYSTEM_PROMPT = `You craft delegation prompts for a frontier model.

Your job is to turn a user's request plus selected memory into a minimized, self-contained prompt with explicit [[user_data]] tagging.

Return JSON only with this exact shape:
{"reviewPrompt":"string"}

Core rules:
- The frontier model has zero prior context. Include everything it actually needs in one pass.
- Include only the minimum user-specific data required to answer well.
- If memory is not actually needed, keep the prompt generic.
- Keep the user's current request in normal prose.
- Every additional fact sourced from memory files or recent conversation that you include must be wrapped in [[user_data]]...[[/user_data]].
- Do not wrap generic instructions, output-format guidance, or your own reasoning in tags.
- Strip personal identifiers unless they are strictly necessary.
- No real names unless the task genuinely requires the specific name.
- No specific location unless the task depends on location.
- Put everything into one final minimized prompt in reviewPrompt.
- Do not include markdown fences or any text outside the JSON object.

Privacy and minimization:
- Every included fact should pass this test: "Does the frontier model need this specific fact to answer well?" If no, leave it out.
- If a memory fact only repeats or confirms what the current query already makes obvious, leave it out.
- Generalize when possible. Prefer "their partner is vegetarian" or just "vegetarian-friendly options" over a partner's real name.
- Open-ended everyday questions usually need less context than planning or personalized analysis questions.
- Do not assume household members are part of the request unless the user's question or the retrieved memory makes that clearly necessary.

Common over-sharing patterns to avoid:
- Do not include background facts that merely restate the topic, interest, or domain already obvious from the user's current query.
- Do not include descriptive biography when the answer only needs concrete constraints, preferences, specs, or requirements.
- Only include memory when it changes the answer: constraints, tradeoffs, personalization, or disambiguation.
- Prefer concise, answer-shaping facts over broad user background.

The user will review the exact prompt before it is sent. Keep it useful, minimal, and explicit.`;

function clipText(value, limit) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n...(truncated)`;
}

function renderFiles(files) {
    const normalizedFiles = Array.isArray(files) ? files : [];
    let usedChars = 0;

    return normalizedFiles.map((file, index) => {
        const path = typeof file?.path === 'string' ? file.path : `memory-${index + 1}.md`;
        let content = typeof file?.content === 'string' ? file.content.trim() : '';
        if (!content) content = '(empty)';

        const remaining = MAX_AUGMENT_TOTAL_CHARS - usedChars;
        if (remaining <= 0) {
            content = '(omitted for length)';
        } else {
            content = clipText(content, Math.min(MAX_AUGMENT_FILE_CHARS, remaining));
            usedChars += content.length;
        }

        return `## ${path}\n${content}`;
    }).join('\n\n');
}

function buildCrafterInput({ userQuery, files, conversationText }) {
    const sections = [
        `User query:\n${userQuery.trim()}`,
        `Retrieved memory files:\n${renderFiles(files)}`
    ];

    const clippedConversation = trimRecentContext(conversationText);
    if (clippedConversation) {
        sections.push(`Recent conversation:\n${clippedConversation}`);
    }

    sections.push(`Produce the JSON now. Remember:
- reviewPrompt should be the exact final prompt that will be shown to the user
- keep the current user request in normal prose
- any extra facts injected from memory or recent conversation must stay wrapped in [[user_data]] tags
- if a memory fact only restates the domain already obvious from the query, omit it
- omit names, relationship labels, and locations unless the prompt really needs them`);

    return sections.join('\n\n');
}

function extractResponseText(response) {
    if (!response) return '';
    if (typeof response.content === 'string') return response.content;
    return '';
}

function parseCrafterJson(rawText) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) {
        throw new Error('augment_query prompt crafter returned an empty response.');
    }

    const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = codeFenceMatch?.[1]?.trim() || text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    const jsonText = (start !== -1 && end !== -1 && end >= start)
        ? candidate.slice(start, end + 1)
        : candidate;

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (error) {
        throw new Error(`augment_query prompt crafter returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
        reviewPrompt: typeof parsed?.reviewPrompt === 'string' ? parsed.reviewPrompt.trim() : ''
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCrafterRetryDelay(attemptIndex) {
    const exponential = AUGMENT_CRAFTER_RETRY_BASE_DELAY_MS * Math.pow(2, attemptIndex);
    const jitter = Math.random() * AUGMENT_CRAFTER_RETRY_BASE_DELAY_MS;
    return exponential + jitter;
}

function normalizeQueryText(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
}

/**
 * Build tool executors for the retrieval (read) flow.
 * @param {StorageBackend} backend
 */
export function createRetrievalExecutors(backend) {
    return {
        list_directory: async ({ dir_path }) => {
            const { files, dirs } = await backend.ls(dir_path || '');
            return JSON.stringify({ files, dirs });
        },
        retrieve_file: async ({ query }) => {
            const results = await backend.search(query);
            const contentPaths = results.map(r => r.path);

            const allFiles = await backend.exportAll();
            const pathMatches = allFiles
                .filter((file) => typeof file?.path === 'string' && typeof file?.content === 'string')
                .filter((file) => !file.path.endsWith('_tree.md'))
                .filter((file) => pathMatchesQuery(file.path, query))
                .map(f => f.path);

            const seen = new Set();
            const paths = [];
            for (const p of [...pathMatches, ...contentPaths]) {
                if (!seen.has(p)) { seen.add(p); paths.push(p); }
            }

            return JSON.stringify({ paths: paths.slice(0, 5), count: Math.min(paths.length, 5) });
        },
        read_file: async ({ path }) => {
            const resolvedPath = typeof backend.resolvePath === 'function'
                ? await backend.resolvePath(path)
                : null;
            const content = await backend.read(resolvedPath || path);
            if (content === null) return JSON.stringify({ error: `File not found: ${path}` });
            return content.length > 1500 ? content.slice(0, 1500) + '...(truncated)' : content;
        }
    };
}

/**
 * Build the executed augment_query tool for the retrieval flow.
 *
 * The outer memory-agent loop chooses relevant files. This executor then runs a
 * dedicated prompt-crafter pass that turns those raw inputs into the final
 * tagged prompt, keeping prompt-crafting fully inside nanomem.
 *
 * @param {object} options
 * @param {StorageBackend} options.backend
 * @param {LLMClient} options.llmClient
 * @param {string} options.model
 * @param {string} options.query
 * @param {string} [options.conversationText]
 * @param {(event: { stage: 'loading', message: string, attempt?: number }) => void} [options.onProgress]
 */
export function createAugmentQueryExecutor({ backend, llmClient, model, query, conversationText, onProgress }) {
    return async ({ user_query, memory_files }) => {
        const selectedPaths = Array.isArray(memory_files)
            ? [...new Set(memory_files.filter((path) => typeof path === 'string' && path.trim()))].slice(0, MAX_AUGMENT_QUERY_FILES)
            : [];
        const originalQuery = normalizeQueryText(query);
        const providedQuery = normalizeQueryText(user_query);
        const effectiveQuery = (typeof user_query === 'string' && providedQuery && providedQuery === originalQuery)
            ? user_query.trim()
            : query;

        if (!effectiveQuery || !effectiveQuery.trim()) {
            return JSON.stringify({ error: 'augment_query requires the original user_query.' });
        }

        if (selectedPaths.length === 0) {
            return JSON.stringify({
                noRelevantMemory: true,
                files: []
            });
        }

        const files = [];
        for (const path of selectedPaths) {
            const resolvedPath = typeof backend.resolvePath === 'function'
                ? await backend.resolvePath(path)
                : null;
            const canonicalPath = resolvedPath || path;
            const raw = await backend.read(canonicalPath);
            if (!raw) continue;
            files.push({ path: canonicalPath, content: raw });
        }

        if (files.length === 0) {
            return JSON.stringify({ error: 'augment_query could not load any selected memory files.' });
        }

        let reviewPrompt = '';
        let crafterError = '';
        const messages = [
            { role: 'system', content: AUGMENT_QUERY_EXECUTOR_SYSTEM_PROMPT },
            {
                role: 'user',
                content: buildCrafterInput({
                    userQuery: effectiveQuery,
                    files,
                    conversationText
                })
            }
        ];

        for (let attempt = 1; attempt <= AUGMENT_CRAFTER_MAX_ATTEMPTS; attempt += 1) {
            let response;
            try {
                onProgress?.({
                    stage: 'loading',
                    message: attempt === 1
                        ? 'Crafting minimized prompt...'
                        : `Retrying prompt crafting (${attempt}/${AUGMENT_CRAFTER_MAX_ATTEMPTS})...`,
                    attempt
                });
                if (typeof llmClient.streamChatCompletion === 'function') {
                    let emittedReasoningPhase = false;
                    let emittedOutputPhase = false;
                    response = /** @type {ChatCompletionResponse} */ (await llmClient.streamChatCompletion({
                        model,
                        messages,
                        temperature: 0,
                        onDelta: (chunk) => {
                            if (!chunk || emittedOutputPhase) return;
                            emittedOutputPhase = true;
                            onProgress?.({
                                stage: 'loading',
                                message: 'Finalizing prompt...',
                                attempt
                            });
                        },
                        onReasoning: (chunk) => {
                            if (!chunk || emittedReasoningPhase) return;
                            emittedReasoningPhase = true;
                            onProgress?.({
                                stage: 'loading',
                                message: 'Minimizing personal context...',
                                attempt
                            });
                        }
                    }));
                } else {
                    response = /** @type {ChatCompletionResponse} */ (await llmClient.createChatCompletion({
                        model,
                        messages,
                        temperature: 0
                    }));
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return JSON.stringify({ error: `augment_query prompt crafting failed: ${message}` });
            }

            try {
                const parsed = parseCrafterJson(extractResponseText(response));
                reviewPrompt = parsed.reviewPrompt;
                if (!reviewPrompt) {
                    throw new Error('augment_query did not produce a reviewPrompt.');
                }
                crafterError = '';
                break;
            } catch (error) {
                crafterError = error instanceof Error ? error.message : String(error);
                if (attempt >= AUGMENT_CRAFTER_MAX_ATTEMPTS) {
                    break;
                }
                const delay = getCrafterRetryDelay(attempt - 1);
                onProgress?.({
                    stage: 'loading',
                    message: `Prompt crafter retry ${attempt + 1}/${AUGMENT_CRAFTER_MAX_ATTEMPTS} after: ${crafterError}`,
                    attempt: attempt + 1
                });
                console.warn(`[nanomem/augment_query] prompt crafter attempt ${attempt}/${AUGMENT_CRAFTER_MAX_ATTEMPTS} failed: ${crafterError}. Retrying in ${Math.round(delay)}ms.`);
                await sleep(delay);
            }
        }

        if (crafterError) {
            return JSON.stringify({ error: `${crafterError} (after ${AUGMENT_CRAFTER_MAX_ATTEMPTS} attempts)` });
        }

        if (!/\[\[user_data\]\]/.test(reviewPrompt)) {
            return JSON.stringify({
                noRelevantMemory: true,
                files: []
            });
        }

        const apiPrompt = stripUserDataTags(reviewPrompt);

        return JSON.stringify({
            reviewPrompt,
            apiPrompt,
            files: files.map((file) => ({
                path: file.path,
                content: clipText(file.content, MAX_AUGMENT_FILE_CHARS)
            }))
        });
    };
}

/**
 * Build tool executors for the extraction (write) flow.
 * @param {StorageBackend} backend
 * @param {ExtractionExecutorHooks} [hooks]
 */
export function createExtractionExecutors(backend, hooks = {}) {
    const { normalizeContent, mergeWithExisting, refreshIndex, onWrite } = hooks;

    return {
        read_file: async ({ path }) => {
            const content = await backend.read(path);
            if (content === null) return JSON.stringify({ error: `File not found: ${path}` });
            return content.length > 2000 ? content.slice(0, 2000) + '...(truncated)' : content;
        },
        create_new_file: async ({ path, content }) => {
            const exists = await backend.exists(path);
            if (exists) return JSON.stringify({ error: `File already exists: ${path}. Use append_memory or update_memory instead.` });
            const normalized = normalizeContent ? normalizeContent(content, path) : content;
            await backend.write(path, normalized);
            if (refreshIndex) await refreshIndex(path);
            onWrite?.(path, '', normalized);
            return JSON.stringify({ success: true, path });
        },
        append_memory: async ({ path, content }) => {
            const existing = await backend.read(path);
            const newContent = mergeWithExisting
                ? mergeWithExisting(existing, content, path)
                : (existing ? existing + '\n\n' + content : content);
            await backend.write(path, newContent);
            if (refreshIndex) await refreshIndex(path);
            onWrite?.(path, existing ?? '', newContent);
            return JSON.stringify({ success: true, path, action: 'appended' });
        },
        update_memory: async ({ path, content }) => {
            const before = await backend.read(path);
            const normalized = normalizeContent ? normalizeContent(content, path) : content;
            await backend.write(path, normalized);
            if (refreshIndex) await refreshIndex(path);
            onWrite?.(path, before ?? '', normalized);
            return JSON.stringify({ success: true, path, action: 'updated' });
        },
        archive_memory: async ({ path, item_text }) => {
            const existing = await backend.read(path);
            if (!existing) return JSON.stringify({ error: `File not found: ${path}` });
            const newContent = removeArchivedItem(existing, item_text, path);
            if (newContent === null) {
                return JSON.stringify({ error: `Could not find an exact memory item match in: ${path}` });
            }
            await backend.write(path, newContent);
            if (refreshIndex) await refreshIndex(path);
            return JSON.stringify({ success: true, path, action: 'archived', removed: item_text });
        },
        delete_memory: async ({ path }) => {
            if (path.endsWith('_tree.md')) {
                return JSON.stringify({ error: 'Cannot delete index files' });
            }
            await backend.delete(path);
            if (refreshIndex) await refreshIndex(path);
            return JSON.stringify({ success: true, path, action: 'deleted' });
        }
    };
}

function removeArchivedItem(content, itemText, path) {
    const raw = String(content || '');
    const target = normalizeFactText(itemText);
    if (!target) return null;

    const parsed = parseBullets(raw);
    if (parsed.length > 0) {
        const remaining = parsed.filter((bullet) => normalizeFactText(bullet.text) !== target);
        if (remaining.length === parsed.length) return null;
        const compacted = compactBullets(remaining, { defaultTopic: inferTopicFromPath(path), maxActivePerTopic: 1000 });
        return renderCompactedDocument(
            compacted.working, compacted.longTerm, compacted.history,
            { titleTopic: inferTopicFromPath(path) }
        );
    }

    const lines = raw.split('\n');
    let removed = false;
    const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        const normalized = trimmed.startsWith('- ')
            ? normalizeFactText(trimmed.slice(2))
            : normalizeFactText(trimmed);
        if (!removed && normalized === target) {
            removed = true;
            return false;
        }
        return true;
    });

    if (!removed) return null;
    return filtered.join('\n').trim();
}

function trimRecentContext(conversationText) {
    return trimRecentConversation(conversationText, {
        maxChars: MAX_AUGMENT_RECENT_CONTEXT_CHARS
    });
}

function stripUserDataTags(text) {
    return String(text ?? '')
        .replace(/\[\[user_data\]\]/g, '')
        .replace(/\[\[\/user_data\]\]/g, '');
}

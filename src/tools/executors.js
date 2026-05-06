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
    ensureBulletMetadata,
    inferTopicFromPath,
    normalizeFactText,
    parseBullets,
    renderCompactedDocument,
    nowIsoDateTime,
} from '../internal/format/index.js';
import { trimRecentConversation } from '../internal/recentConversation.js';
import { augmentCrafterPrompt } from '../prompts/retrieval.js';

const MAX_AUGMENT_QUERY_FILES = 8;
const MAX_AUGMENT_FILE_CHARS = 1800;
const MAX_AUGMENT_TOTAL_CHARS = 12000;
const MAX_AUGMENT_RECENT_CONTEXT_CHARS = 3000;
const AUGMENT_CRAFTER_MAX_ATTEMPTS = 3;
const AUGMENT_CRAFTER_RETRY_BASE_DELAY_MS = 350;

const AUGMENT_QUERY_EXECUTOR_SYSTEM_PROMPT = augmentCrafterPrompt;

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
 * @param {object} options
 * @param {LLMClient} options.llmClient
 * @param {string} options.model
 * @param {string} options.query
 * @param {{ path: string; content: string }[]} options.files
 * @param {string} [options.conversationText]
 * @param {(event: { stage: 'loading', message: string, attempt?: number }) => void} [options.onProgress]
 * @returns {Promise<{ reviewPrompt?: string, apiPrompt?: string, noRelevantMemory?: boolean, error?: string }>}
 */
export async function craftAugmentedPromptFromFiles({ llmClient, model, query, files, conversationText, onProgress }) {
    const effectiveQuery = normalizeQueryText(query);
    if (!effectiveQuery) {
        return { error: 'augment_query requires the original user_query.' };
    }

    const selectedFiles = Array.isArray(files)
        ? files.filter((file) => typeof file?.content === 'string' && file.content.trim())
        : [];
    if (selectedFiles.length === 0) {
        return { noRelevantMemory: true };
    }

    let reviewPrompt = '';
    let crafterError = '';
    const messages = /** @type {import('../types.js').LLMMessage[]} */ ([
        { role: 'system', content: AUGMENT_QUERY_EXECUTOR_SYSTEM_PROMPT },
        {
            role: 'user',
            content: buildCrafterInput({
                userQuery: query,
                files: selectedFiles,
                conversationText
            })
        }
    ]);

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
            return { error: `augment_query prompt crafting failed: ${message}` };
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
        return { error: `${crafterError} (after ${AUGMENT_CRAFTER_MAX_ATTEMPTS} attempts)` };
    }

    if (!/\[\[user_data(?:_uncertain)?\]\]/.test(reviewPrompt)) {
        return { noRelevantMemory: true };
    }

    return {
        reviewPrompt,
        apiPrompt: stripUserDataTags(reviewPrompt)
    };
}

const MAX_READ_FILE_CHARS = 10000;
const MAX_SEARCH_RESULT_FILES = 5;
const MAX_SEARCH_LINES_PER_FILE = 8;

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
        search_memory: async ({ query }) => {
            const trimmed = String(query || '').trim();
            if (!trimmed) return JSON.stringify({ results: [], count: 0 });

            const hits = await backend.search(trimmed);
            const results = hits.slice(0, MAX_SEARCH_RESULT_FILES).map(({ path, lines }) => ({
                path,
                lines: lines.slice(0, MAX_SEARCH_LINES_PER_FILE)
            }));

            return JSON.stringify({ results, count: results.length });
        },
        read_file: async ({ path }) => {
            const resolvedPath = typeof backend.resolvePath === 'function'
                ? await backend.resolvePath(path)
                : null;
            const content = await backend.read(resolvedPath || path);
            if (content === null) return JSON.stringify({ error: `File not found: ${path}` });
            return content.length > MAX_READ_FILE_CHARS
                ? content.slice(0, MAX_READ_FILE_CHARS) + '...(truncated)'
                : content;
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

        // Pre-filter each file to only bullets relevant to the query so the crafter
        // sees focused signal rather than the full file with unrelated bullets.
        const crafterFiles = files.map(file => {
            const filtered = filterBulletsForCrafter(file.content, effectiveQuery);
            return filtered ? { path: file.path, content: filtered } : file;
        });

        const crafted = await craftAugmentedPromptFromFiles({
            llmClient,
            model,
            query: effectiveQuery,
            files: crafterFiles,
            conversationText,
            onProgress
        });

        if (crafted.error) {
            return JSON.stringify({ error: crafted.error });
        }

        if (crafted.noRelevantMemory) {
            return JSON.stringify({
                noRelevantMemory: true,
                files: []
            });
        }

        return JSON.stringify({
            reviewPrompt: crafted.reviewPrompt,
            apiPrompt: crafted.apiPrompt,
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
    const { normalizeContent, mergeWithExisting, refreshIndex, onWrite, updatedAt } = hooks;

    return {
        read_file: async ({ path }) => {
            const content = await backend.read(path);
            if (content === null) return JSON.stringify({ error: `File not found: ${path}` });
            return content.length > 2000 ? content.slice(0, 2000) + '...(truncated)' : content;
        },
        create_new_file: async ({ path, content }) => {
            const exists = await backend.exists(path);
            if (exists) return JSON.stringify({ error: `File already exists: ${path}. Use append_memory or update_bullets instead.` });
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
        update_bullets: async ({ path, updates }) => {
            const before = await backend.read(path);
            if (!before) return JSON.stringify({ error: `File not found: ${path}` });
            if (!Array.isArray(updates) || updates.length === 0) return JSON.stringify({ error: 'updates must be a non-empty array' });

            const parsed = parseBullets(before);
            const defaultTopic = inferTopicFromPath(path);
            const effectiveUpdatedAt = updatedAt || nowIsoDateTime();
            let matchedCount = 0;
            const errors = [];

            for (const { old_fact, new_fact } of updates) {
                const factText = typeof old_fact === 'string' && old_fact.includes('|')
                    ? old_fact.split('|')[0].trim()
                    : String(old_fact || '').trim();
                const target = normalizeFactText(factText);
                if (!target) { errors.push('empty old_fact'); continue; }

                const idx = parsed.findIndex((b) => normalizeFactText(b.text) === target);
                if (idx === -1) { errors.push(`No match: ${factText}`); continue; }

                // Supersede the old bullet and push a new active replacement.
                // Strip any metadata the LLM may have included in new_fact.
                const oldBullet = parsed[idx];
                const rawNewFact = String(new_fact || '').trim();
                const cleanNewFact = rawNewFact.includes('|')
                    ? rawNewFact.split('|')[0].trim()
                    : rawNewFact;
                parsed[idx] = { ...oldBullet, status: 'superseded', tier: 'history' };
                parsed.push(ensureBulletMetadata(
                    {
                        text: cleanNewFact,
                        topic: oldBullet.topic,
                        source: oldBullet.source,
                        confidence: oldBullet.confidence,
                    },
                    { defaultTopic, updatedAt: effectiveUpdatedAt }
                ));
                matchedCount++;
            }

            if (matchedCount === 0) {
                return JSON.stringify({ error: errors.join('; ') || 'No bullets matched' });
            }

            const compacted = compactBullets(parsed, { defaultTopic, maxActivePerTopic: 1000 });
            const after = renderCompactedDocument(
                compacted.working, compacted.longTerm, compacted.history,
                { titleTopic: defaultTopic }
            );
            await backend.write(path, after);
            if (refreshIndex) await refreshIndex(path);
            onWrite?.(path, before, after);
            const result = { success: true, path, action: 'bullets_updated', updated: matchedCount };
            if (errors.length) result.errors = errors;
            return JSON.stringify(result);
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

/**
 * Build tool executors for the deletion flow.
 * @param {StorageBackend} backend
 * @param {{ refreshIndex?: Function, onWrite?: Function }} [hooks]
 */
export function createDeletionExecutors(backend, hooks = {}) {
    const { refreshIndex, onWrite } = hooks;

    return {
        list_directory: async ({ dir_path }) => {
            const { files, dirs } = await backend.ls(dir_path || '');
            return JSON.stringify({ files, dirs });
        },
        retrieve_file: async ({ query }) => {
            const results = await backend.search(query);
            const contentPaths = results.map(r => r.path);

            const allFiles = await backend.exportAll();
            const queryLower = query.toLowerCase();
            const pathMatches = allFiles
                .filter(f => !f.path.endsWith('_tree.md') && f.path.toLowerCase().includes(queryLower))
                .map(f => f.path);

            const seen = new Set();
            const paths = [];
            for (const p of [...pathMatches, ...contentPaths]) {
                if (!seen.has(p)) { seen.add(p); paths.push(p); }
            }

            return JSON.stringify({ paths: paths.slice(0, 5), count: Math.min(paths.length, 5) });
        },
        read_file: async ({ path }) => {
            const content = await backend.read(path);
            if (content === null) return JSON.stringify({ error: `File not found: ${path}` });
            return content;
        },
        delete_bullet: async ({ path, bullet_text }) => {
            const before = await backend.read(path);
            if (!before) return JSON.stringify({ error: `File not found: ${path}` });
            // Strip pipe-delimited metadata if present — removeArchivedItem matches
            // against bullet.text (fact text only), not the full line with metadata.
            const factText = bullet_text.includes('|')
                ? bullet_text.split('|')[0].trim()
                : bullet_text.trim();
            const after = removeArchivedItem(before, factText, path);
            if (after === null) {
                return JSON.stringify({ error: `No exact match found for the given bullet text in: ${path}` });
            }
            // If no bullets remain, delete the file entirely instead of leaving empty headers.
            const remaining = parseBullets(after);
            if (remaining.length === 0) {
                await backend.delete(path);
                if (refreshIndex) await refreshIndex(path);
                onWrite?.(path, before, null);
                return JSON.stringify({ success: true, path, action: 'file_deleted', removed: factText });
            }
            await backend.write(path, after);
            if (refreshIndex) await refreshIndex(path);
            onWrite?.(path, before, after);
            return JSON.stringify({ success: true, path, action: 'deleted', removed: factText });
        },
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

/**
 * Filter a memory file's bullets down to only those relevant to the query.
 * Returns a compact string of "- text | confidence=X" lines, or null if
 * the file has no parseable bullets or no relevant ones.
 *
 * This prevents the crafter from drowning in a large file of unrelated bullets
 * and picking just one (or the wrong) fact.
 */
function filterBulletsForCrafter(content, query) {
    const bullets = parseBullets(content);
    if (bullets.length === 0) return null;

    const tokens = queryTerms(query);

    const active = bullets.filter(b => {
        const tier = String(b.tier || b.section || 'long_term').toLowerCase();
        const status = String(b.status || 'active').toLowerCase();
        return tier !== 'history' && status !== 'superseded' && status !== 'expired';
    });
    if (active.length === 0) return null;

    const scored = active.map(b => {
        const text = String(b.text || '').toLowerCase();
        const topic = String(b.topic || '').toLowerCase();
        let score = 0;
        for (const t of tokens) {
            if (text.includes(t)) score += 2;
            if (topic.includes(t)) score += 1;
        }
        return { bullet: b, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    return scored.slice(0, 20)
        .map(x => `- ${x.bullet.text} | confidence=${x.bullet.confidence}`)
        .join('\n');
}

function stripUserDataTags(text) {
    return String(text ?? '')
        .replace(/\[\[user_data\]\]/g, '')
        .replace(/\[\[\/user_data\]\]/g, '')
        .replace(/\[\[user_data_uncertain\]\]/g, '(less certain: ')
        .replace(/\[\[\/user_data_uncertain\]\]/g, ')');
}

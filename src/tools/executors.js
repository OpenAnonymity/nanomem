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
    bumpDownConfidence,
    bumpUpConfidence,
    compactBullets,
    ensureBulletMetadata,
    generateBulletId,
    inferTopicFromPath,
    normalizeFactText,
    parseBullets,
    renderCompactedDocument,
    nowIsoDateTime,
} from '../internal/format/index.js';
import {
    appendVlogEntry,
    buildConfidenceEntry,
    buildContentUpdateEntries,
    buildCreatedEntry,
    buildDeletedEntry,
    getCurrentV,
} from '../internal/vlog.js';
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

function stripHistorySection(content) {
    if (typeof content !== 'string') return content;
    const historyIdx = content.search(/^## History/im);
    return historyIdx === -1 ? content : content.slice(0, historyIdx).trimEnd();
}

function wordOverlap(a, b) {
    const setA = new Set(a.split(' ').filter(Boolean));
    const setB = new Set(b.split(' ').filter(Boolean));
    if (setA.size === 0 || setB.size === 0) return 0;
    let shared = 0;
    for (const w of setA) if (setB.has(w)) shared++;
    return shared / Math.max(setA.size, setB.size);
}

function fuzzyFindBullet(parsed, target) {
    const candidates = parsed
        .map((b, i) => ({ b, i, score: wordOverlap(normalizeFactText(b.text), target) }))
        .filter(({ b, score }) => b.section !== 'history' && score >= 0.5)
        .sort((a, b) => b.score - a.score);
    return candidates.length > 0 ? candidates[0].i : -1;
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
- preserve the user's grammatical perspective; for first-person requests, added memory facts should also be first-person
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

function sleep(ms, signal = null) {
    return new Promise((resolve, reject) => {
        let timeoutId = null;
        const cleanup = () => {
            if (timeoutId !== null) clearTimeout(timeoutId);
            if (signal) signal.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(createAbortError());
        };
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        timeoutId = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
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
 * @param {AbortSignal | null} [options.signal]
 * @returns {Promise<{ reviewPrompt?: string, apiPrompt?: string, noRelevantMemory?: boolean, error?: string }>}
 */
export async function craftAugmentedPromptFromFiles({ llmClient, model, query, files, conversationText, onProgress, signal = null }) {
    const effectiveQuery = normalizeQueryText(query);
    if (!effectiveQuery) {
        return { error: 'augment_query requires the original user_query.' };
    }
    throwIfAborted(signal);

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
                    signal,
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
                    temperature: 0,
                    signal
                }));
            }
        } catch (error) {
            if (isAbortError(error, signal)) throw error;
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
            await sleep(delay, signal);
        }
    }

    if (crafterError) {
        return { error: `${crafterError} (after ${AUGMENT_CRAFTER_MAX_ATTEMPTS} attempts)` };
    }

    if (!/\[\[user_data\]\]/.test(reviewPrompt)) {
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
    const isVlog = (p) => typeof p === 'string' && (p === '_vlog' || p.startsWith('_vlog/'));
    return {
        list_directory: async ({ dir_path }) => {
            const { files, dirs } = await backend.ls(dir_path || '');
            return JSON.stringify({
                files: files.filter((f) => !isVlog(f)),
                dirs: dirs.filter((d) => !isVlog(d))
            });
        },
        search_memory: async ({ query }) => {
            const trimmed = String(query || '').trim();
            if (!trimmed) return JSON.stringify({ results: [], count: 0 });

            const hits = await backend.search(trimmed);
            const results = hits
                .filter(({ path }) => !isVlog(path))
                .slice(0, MAX_SEARCH_RESULT_FILES)
                .map(({ path, lines }) => ({
                    path,
                    lines: lines.slice(0, MAX_SEARCH_LINES_PER_FILE)
                }));

            return JSON.stringify({ results, count: results.length });
        },
        read_file: async ({ path }) => {
            if (isVlog(path)) return JSON.stringify({ error: `File not found: ${path}` });
            const resolvedPath = typeof backend.resolvePath === 'function'
                ? await backend.resolvePath(path)
                : null;
            const content = await backend.read(resolvedPath || path);
            if (content === null) return JSON.stringify({ error: `File not found: ${path}` });
            const active = stripHistorySection(content);
            return active.length > MAX_READ_FILE_CHARS
                ? active.slice(0, MAX_READ_FILE_CHARS) + '...(truncated)'
                : active;
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
 * @param {AbortSignal | null} [options.signal]
 */
export function createAugmentQueryExecutor({ backend, llmClient, model, query, conversationText, onProgress, signal = null }) {
    return async ({ user_query, memory_files }) => {
        throwIfAborted(signal);
        const selectedPaths = Array.isArray(memory_files)
            ? [...new Set(memory_files.filter((path) => typeof path === 'string' && path.trim() && !path.startsWith('_vlog/')))].slice(0, MAX_AUGMENT_QUERY_FILES)
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
            throwIfAborted(signal);
            const resolvedPath = typeof backend.resolvePath === 'function'
                ? await backend.resolvePath(path)
                : null;
            const canonicalPath = resolvedPath || path;
            const raw = await backend.read(canonicalPath);
            if (!raw) continue;
            files.push({ path: canonicalPath, content: stripHistorySection(raw) });
        }

        if (files.length === 0) {
            return JSON.stringify({ error: 'augment_query could not load any selected memory files.' });
        }

        const crafted = await craftAugmentedPromptFromFiles({
            llmClient,
            model,
            query: effectiveQuery,
            files,
            conversationText,
            onProgress,
            signal
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
            return content.length > MAX_READ_FILE_CHARS ? content.slice(0, MAX_READ_FILE_CHARS) + '...(truncated)' : content;
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

                let idx = parsed.findIndex((b) => normalizeFactText(b.text) === target);
                if (idx === -1) idx = fuzzyFindBullet(parsed, target);
                if (idx === -1) { errors.push(`No match: ${factText}`); continue; }

                // Supersede the old bullet and push a new active replacement.
                // Strip any metadata the LLM may have included in new_fact.
                // Stamp ID onto legacy bullets (no id in storage) before superseding.
                if (!parsed[idx].id) parsed[idx] = { ...parsed[idx], id: generateBulletId() };
                const oldBullet = parsed[idx];
                const rawNewFact = String(new_fact || '').trim();
                const cleanNewFact = rawNewFact.includes('|')
                    ? rawNewFact.split('|')[0].trim()
                    : rawNewFact;
                const oldConfidence = oldBullet.confidence;
                const decayedConfidence = bumpDownConfidence(oldConfidence);
                const oldBulletV = await getCurrentV(backend, path, oldBullet.id);
                parsed[idx] = {
                    ...oldBullet,
                    status: 'superseded',
                    tier: 'history',
                    confidence: decayedConfidence,
                    prevConfidence: oldConfidence,
                    v: oldBulletV + 1,
                };
                const newBullet = ensureBulletMetadata(
                    {
                        text: cleanNewFact,
                        topic: oldBullet.topic,
                        source: oldBullet.source,
                        confidence: oldBullet.confidence,
                        id: generateBulletId(),
                        v: 1,
                        supersedes: oldBullet.id,
                    },
                    { defaultTopic, updatedAt: effectiveUpdatedAt }
                );
                parsed.push(newBullet);

                const { oldEntry, newEntry } = buildContentUpdateEntries(
                    newBullet, oldBullet.id, oldBulletV, oldConfidence, effectiveUpdatedAt
                );
                await appendVlogEntry(backend, path, oldEntry);
                await appendVlogEntry(backend, path, newEntry);
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
        corroborate_bullet: async ({ path, fact_text }) => {
            const before = await backend.read(path);
            if (!before) return JSON.stringify({ error: `File not found: ${path}` });

            const factText = typeof fact_text === 'string' && fact_text.includes('|')
                ? fact_text.split('|')[0].trim()
                : String(fact_text || '').trim();
            const target = normalizeFactText(factText);
            if (!target) return JSON.stringify({ error: 'empty fact_text' });

            const parsed = parseBullets(before);
            const idx = parsed.findIndex((b) => normalizeFactText(b.text) === target);
            if (idx === -1) return JSON.stringify({ error: `No matching bullet in ${path} for: ${factText}` });

            // Ensure legacy bullets (no id in storage) get a stable ID before mutation.
            const matched = { ...parsed[idx], id: parsed[idx].id || generateBulletId() };
            parsed[idx] = matched;
            const wasInHistory = matched.tier === 'history' || matched.status === 'superseded';
            const confidenceBefore = matched.confidence;
            const confidenceAfter = bumpUpConfidence(matched.confidence);
            const defaultTopic = inferTopicFromPath(path);
            const effectiveUpdatedAt = updatedAt || nowIsoDateTime();

            const nextV = (await getCurrentV(backend, path, matched.id)) + 1;
            parsed[idx] = wasInHistory
                ? {
                    ...matched,
                    tier: 'long_term',
                    status: 'active',
                    section: 'long_term',
                    confidence: confidenceAfter,
                    prevConfidence: confidenceBefore,
                    v: nextV,
                    updatedAt: effectiveUpdatedAt,
                    explicitConfidence: true,
                }
                : {
                    ...matched,
                    confidence: confidenceAfter,
                    prevConfidence: confidenceBefore,
                    v: nextV,
                    updatedAt: effectiveUpdatedAt,
                    explicitConfidence: true,
                };

            await appendVlogEntry(backend, path, buildConfidenceEntry(
                parsed[idx], confidenceBefore, 'corroboration', effectiveUpdatedAt
            ));

            const compacted = compactBullets(parsed, { defaultTopic, maxActivePerTopic: 1000 });
            const after = renderCompactedDocument(
                compacted.working, compacted.longTerm, compacted.history,
                { titleTopic: defaultTopic }
            );
            await backend.write(path, after);
            if (refreshIndex) await refreshIndex(path);
            onWrite?.(path, before, after);
            return JSON.stringify({
                success: true,
                path,
                action: wasInHistory ? 'revived' : 'corroborated',
                confidence_before: confidenceBefore,
                confidence_after: confidenceAfter,
            });
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
            const content = await backend.read(path);
            if (content) {
                const at = updatedAt || nowIsoDateTime();
                const bullets = parseBullets(content).filter(b => b.id && b.section !== 'history');
                for (const bullet of bullets) {
                    const currentV = await getCurrentV(backend, path, bullet.id);
                    await appendVlogEntry(backend, path, buildDeletedEntry({ ...bullet, v: currentV }, at));
                }
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

            const allBullets = parseBullets(before);
            const target = normalizeFactText(factText);
            const deletedBullet = allBullets.find(b => normalizeFactText(b.text) === target);

            const after = removeArchivedItem(before, factText, path);
            if (after === null) {
                return JSON.stringify({ error: `No exact match found for the given bullet text in: ${path}` });
            }

            if (deletedBullet?.id) {
                const currentV = await getCurrentV(backend, path, deletedBullet.id);
                await appendVlogEntry(backend, path, buildDeletedEntry({ ...deletedBullet, v: currentV }, nowIsoDateTime()));
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

function stripUserDataTags(text) {
    return String(text ?? '')
        .replace(/\[\[user_data\]\]/g, '')
        .replace(/\[\[\/user_data\]\]/g, '');
}

function createAbortError() {
    const error = new Error('Memory prompt crafting aborted.');
    error.name = 'AbortError';
    error.aborted = true;
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

function isAbortError(error, signal) {
    return !!signal?.aborted || error?.name === 'AbortError' || error?.aborted === true;
}

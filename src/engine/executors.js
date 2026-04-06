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
/** @import { ExtractionExecutorHooks, StorageBackend } from '../types.js' */
import {
    compactBullets,
    inferTopicFromPath,
    normalizeFactText,
    parseBullets,
    renderCompactedDocument,
} from '../bullets/index.js';

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
            return content.length > 1500 ? content.slice(0, 1500) + '...(truncated)' : content;
        }
    };
}

/**
 * Build tool executors for the extraction (write) flow.
 * @param {StorageBackend} backend
 * @param {ExtractionExecutorHooks} [hooks]
 */
export function createExtractionExecutors(backend, hooks = {}) {
    const { normalizeContent, mergeWithExisting, refreshIndex } = hooks;

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
            return JSON.stringify({ success: true, path });
        },
        append_memory: async ({ path, content }) => {
            const existing = await backend.read(path);
            const newContent = mergeWithExisting
                ? mergeWithExisting(existing, content, path)
                : (existing ? existing + '\n\n' + content : content);
            await backend.write(path, newContent);
            if (refreshIndex) await refreshIndex(path);
            return JSON.stringify({ success: true, path, action: 'appended' });
        },
        update_memory: async ({ path, content }) => {
            const normalized = normalizeContent ? normalizeContent(content, path) : content;
            await backend.write(path, normalized);
            if (refreshIndex) await refreshIndex(path);
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

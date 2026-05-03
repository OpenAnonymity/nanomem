/**
 * @openanonymity/nanomem — LLM-driven personal memory.
 *
 * createMemoryBank(config) is the main entry point.
 *
 * Returned object has three named groups:
 *
 *   Engine   (LLM-driven):  init, retrieve, ingest, compact
 *   Backends (storage ops): mem.storage.{ read, write, delete, exists,
 *                                           search, ls, getTree,
 *                                           rebuildTree, exportAll }
 *   Utilities  (portability): mem.serialize(), mem.toZip()
 */
/** @import { LLMClient, MemoryBank, MemoryBankConfig, MemoryBankLLMConfig, Message, IngestOptions, RetrievalResult, AdaptiveRetrievalResult, AugmentQueryResult, AdaptiveAugmentQueryResult, StorageBackend } from './types.js' */

import { createOpenAIClient } from './internal/llm-client/openai.js';
import { createAnthropicClient } from './internal/llm-client/anthropic.js';
import { createTinfoilClient } from './internal/llm-client/tinfoil.js';
import { MemoryBulletIndex } from './internal/format/bulletIndex.js';
import { MemoryRetriever } from './tools/retrieval.js';
import { MemoryIngester } from './tools/ingestion.js';
import { MemoryDeleter } from './tools/deletion.js';
import { MemoryCompactor } from './tools/compaction.js';
import { InMemoryStorage } from './internal/storage/ram.js';
import { importData as importMemoryData } from './internal/imports/importData.js';
import { serialize, toZip } from './internal/portability.js';
import { buildOmfExport, previewOmfImport, importOmf } from './internal/omf.js';

/**
 * Remove review-only [[user_data]] markers before sending the final prompt to
 * the frontier model.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripUserDataTags(text) {
    return String(text ?? '')
        .replace(/\[\[user_data\]\]/g, '')
        .replace(/\[\[\/user_data\]\]/g, '');
}

/**
 * Create a memory instance.
 *
 * @param {MemoryBankConfig} [config]
 * @returns {MemoryBank}
 */
export function createMemoryBank(config = {}) {
    const llmClient = config.llmClient || _createLlmClient(config.llm);
    const model = config.model || config.llm?.model || 'gpt-4o';
    const backend = _createBackend(config.storage, config.storagePath);
    const bulletIndex = new MemoryBulletIndex(backend);

    const retrieval = new MemoryRetriever({
        backend, bulletIndex, llmClient, model,
        onProgress: config.onProgress,
        onModelText: config.onModelText,
    });
    const ingester = new MemoryIngester({
        backend, bulletIndex, llmClient, model,
        onToolCall: config.onToolCall,
    });
    const compactor = new MemoryCompactor({ backend, bulletIndex, llmClient, model, onProgress: config.onCompactProgress });
    const deleter = new MemoryDeleter({ backend, bulletIndex, llmClient, model, onToolCall: config.onToolCall });

    async function write(path, content) {
        await backend.write(path, content);
        await bulletIndex.refreshPath(path);
    }

    async function remove(path) {
        await backend.delete(path);
        await bulletIndex.refreshPath(path);
    }

    async function rebuildTree() {
        await backend.rebuildTree();
        await bulletIndex.rebuild();
    }

    // ─── Public API ──────────────────────────────────────────────
    return {
        /** Initialize the storage backend (creates seed files if empty). */
        init: () => backend.init(),

        // ─── High-level (LLM-driven) ──────────────────────────────

        /**
         * Retrieve relevant memory context for a query.
         * @param {string} query
         * @param {string} [conversationText] current session text for reference resolution
         * @returns {Promise<RetrievalResult | null>}
         */
        retrieve: (query, conversationText) => retrieval.retrieveForQuery(query, conversationText),

        /**
         * Adaptive retrieval for multi-turn sessions. Only fetches new memory if
         * alreadyRetrievedContext does not already cover the current query.
         * Returns AdaptiveRetrievalResult (never null on success) — check .skipped
         * and .skipReason to know if retrieval was bypassed.
         * @param {string} query
         * @param {string} [alreadyRetrievedContext] memory already in the session
         * @param {string} [conversationText] recent conversation for reference resolution
         * @returns {Promise<AdaptiveRetrievalResult | null>}
         */
        retrieveAdaptive: (query, alreadyRetrievedContext, conversationText, previousConfidence) =>
            retrieval.retrieveAdaptively(query, alreadyRetrievedContext, conversationText, previousConfidence),

        /**
         * Build a reviewable prompt that augments the user query with memory.
         * @param {string} query
         * @param {string} [conversationText]
         * @returns {Promise<AugmentQueryResult | null>}
         */
        augmentQuery: (query, conversationText) => retrieval.augmentQueryForPrompt(query, conversationText),

        /**
         * Adaptive prompt augmentation for multi-turn sessions. Returns skipped=true
         * when alreadyRetrievedContext is enough, otherwise crafts a prompt from
         * only newly retrieved memory.
         * @param {string} query
         * @param {string} [alreadyRetrievedContext] memory already in the session
         * @param {string} [conversationText]
         * @returns {Promise<AdaptiveAugmentQueryResult | null>}
         */
        augmentQueryAdaptive: (query, alreadyRetrievedContext, conversationText) =>
            retrieval.augmentQueryAdaptively(query, alreadyRetrievedContext, conversationText),

        /**
         * Ingest facts from a conversation into memory.
         * @param {Message[]} messages
         * @param {IngestOptions} [options]
         */
        ingest: (messages, options) => ingester.ingest(messages, options),

        /**
         * Import supported conversation/document formats into memory.
         */
        importData: (input, options) => importMemoryData({
            init: () => backend.init(),
            ingest: (messages, ingestOptions) => ingester.ingest(messages, ingestOptions)
        }, input, options),
        exportOmf: async () => {
            await backend.init();
            return buildOmfExport({
                read: (path) => backend.read(path),
                write: (path, content) => write(path, content),
                delete: (path) => remove(path),
                exists: (path) => backend.exists(path),
                search: (query) => backend.search(query),
                ls: (dirPath) => backend.ls(dirPath),
                getTree: () => backend.getTree(),
                rebuildTree: () => rebuildTree(),
                exportAll: () => backend.exportAll(),
                clear: () => backend.clear(),
            }, { sourceApp: 'nanomem' });
        },
        previewOmfImport: async (doc, options) => {
            await backend.init();
            return previewOmfImport({
                read: (path) => backend.read(path),
                write: (path, content) => write(path, content),
                delete: (path) => remove(path),
                exists: (path) => backend.exists(path),
                search: (query) => backend.search(query),
                ls: (dirPath) => backend.ls(dirPath),
                getTree: () => backend.getTree(),
                rebuildTree: () => rebuildTree(),
                exportAll: () => backend.exportAll(),
                clear: () => backend.clear(),
            }, doc, options);
        },
        importOmf: async (doc, options) => {
            await backend.init();
            return importOmf({
                read: (path) => backend.read(path),
                write: (path, content) => write(path, content),
                delete: (path) => remove(path),
                exists: (path) => backend.exists(path),
                search: (query) => backend.search(query),
                ls: (dirPath) => backend.ls(dirPath),
                getTree: () => backend.getTree(),
                rebuildTree: () => rebuildTree(),
                exportAll: () => backend.exportAll(),
                clear: () => backend.clear(),
            }, doc, options);
        },

        /** Compact all memory files (dedup, archive stale facts). */
        compact: () => compactor.compactAll(),

        /** Archive any facts whose expires_at date has passed (no LLM, deterministic). */
        pruneExpired: () => compactor.pruneExpired(),

        /**
         * Delete memory content matching a plain-text query.
         * @param {string} query
         * @returns {Promise<{ status: string, deleteCalls: number, writes: Array }>}
         */
        deleteContent: (query, options) => deleter.deleteForQuery(query, options),

        // ─── Low-level (direct storage ops) ──────────────────────

        storage: {
            read:         (path)          => backend.read(path),
            resolvePath:  (path)          => backend.resolvePath ? backend.resolvePath(path) : Promise.resolve(null),
            write:        (path, content) => write(path, content),
            delete:       (path)          => remove(path),
            exists:       (path)          => backend.exists(path),
            search:       (query)         => backend.search(query),
            ls:           (dirPath)       => backend.ls(dirPath),
            getTree:     ()              => backend.getTree(),
            rebuildTree: ()              => rebuildTree(),
            exportAll:    ()              => backend.exportAll(),
            clear:        ()              => backend.clear(),
        },

        // ─── Utilities (portability) ──────────────────────────────

        /** Serialize entire memory state to a single portable string. */
        serialize: async () => serialize(await backend.exportAll()),

        /** Serialize entire memory state to a ZIP archive (Uint8Array). */
        toZip: async () => toZip(await backend.exportAll()),

        // ─── Internals (for advanced use / testing) ──────────────
        _backend: backend,
        _bulletIndex: bulletIndex,
    };
}

// ─── Internal Helpers ────────────────────────────────────────────

function _createLlmClient(llmConfig = /** @type {MemoryBankLLMConfig} */ ({ apiKey: '' })) {
    const { apiKey, baseUrl, headers, provider } = llmConfig;
    if (!apiKey) {
        throw new Error('createMemoryBank: config.llm.apiKey is required (or provide config.llmClient)');
    }

    const detectedProvider = provider || _detectProvider(baseUrl);

    if (detectedProvider === 'anthropic') {
        return createAnthropicClient({ apiKey, baseUrl, headers });
    }

    if (detectedProvider === 'tinfoil') {
        return createTinfoilClient(llmConfig);
    }

    return createOpenAIClient({ apiKey, baseUrl, headers });
}

function _detectProvider(baseUrl) {
    if (!baseUrl) return 'openai';
    const lower = baseUrl.toLowerCase();
    if (lower.includes('anthropic.com')) return 'anthropic';
    if (lower.includes('tinfoil.sh')) return 'tinfoil';
    return 'openai';
}

function _createBackend(storage, storagePath) {
    // Custom backend object
    if (storage && typeof storage === 'object' && typeof storage.read === 'function') {
        return storage;
    }

    const storageType = typeof storage === 'string' ? storage : 'ram';

    switch (storageType) {
        case 'indexeddb':
            return _asyncBackend(() => import('./internal/storage/indexeddb.js').then(m => new m.IndexedDBStorage()));
        case 'filesystem':
            return _asyncBackend(() => import('./internal/storage/filesystem.js').then(m => new m.FileSystemStorage(storagePath || 'nanomem')));
        case 'ram':
        default:
            return new InMemoryStorage();
    }
}

function _asyncBackend(loader) {
    let _backend = null;
    let _loading = null;

    async function resolve() {
        if (_backend) return _backend;
        if (!_loading) _loading = loader().then(b => { _backend = b; return b; });
        return _loading;
    }

    const methods = ['init', 'read', 'resolvePath', 'write', 'delete', 'exists', 'ls', 'search', 'getTree', 'rebuildTree', 'exportAll', 'clear'];
    const proxy = {};
    for (const method of methods) {
        proxy[method] = async (...args) => {
            const backend = await resolve();
            return backend[method](...args);
        };
    }
    return /** @type {StorageBackend} */ (proxy);
}

// ─── Re-exports ──────────────────────────────────────────────────

/** Re-export all shared type definitions for consumers. */
export * from './types.js';
export { createOpenAIClient } from './internal/llm-client/openai.js';
export { createAnthropicClient } from './internal/llm-client/anthropic.js';
export { InMemoryStorage } from './internal/storage/ram.js';
export { BaseStorage } from './internal/storage/BaseStorage.js';
export { MemoryBulletIndex } from './internal/format/bulletIndex.js';
export { MemoryRetriever } from './tools/retrieval.js';
export { MemoryIngester } from './tools/ingestion.js';
export { MemoryCompactor } from './tools/compaction.js';
export { createRetrievalExecutors, createExtractionExecutors } from './tools/executors.js';
export { serialize, deserialize, toZip } from './internal/portability.js';
export { buildOmfExport, previewOmfImport, importOmf, parseOmfText, validateOmf } from './internal/omf.js';
export {
    extractSessionsFromOAFastchatExport,
    extractConversationFromOAFastchatExport,
    listOAFastchatSessions
} from './internal/imports/oaFastchat.js';

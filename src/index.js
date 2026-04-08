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
/** @import { LLMClient, MemoryBank, MemoryBankConfig, MemoryBankLLMConfig, Message, IngestOptions, RetrievalResult, StorageBackend } from './types.js' */

import { createOpenAIClient } from './llm/openai.js';
import { createAnthropicClient } from './llm/anthropic.js';
import { MemoryBulletIndex } from './bullets/bulletIndex.js';
import { MemoryRetriever } from './engine/retriever.js';
import { MemoryIngester } from './engine/ingester.js';
import { MemoryCompactor } from './engine/compactor.js';
import { InMemoryStorage } from './backends/ram.js';
import { serialize, toZip } from './utils/portability.js';

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
         * Ingest facts from a conversation into memory.
         * @param {Message[]} messages
         * @param {IngestOptions} [options]
         */
        ingest: (messages, options) => ingester.ingest(messages, options),

        /** Compact all memory files (dedup, archive stale facts). */
        compact: () => compactor.compactAll(),

        // ─── Low-level (direct storage ops) ──────────────────────

        storage: {
            read:         (path)          => backend.read(path),
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

    return createOpenAIClient({ apiKey, baseUrl, headers });
}

function _detectProvider(baseUrl) {
    if (!baseUrl) return 'openai';
    const lower = baseUrl.toLowerCase();
    if (lower.includes('anthropic.com')) return 'anthropic';
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
            return _asyncBackend(() => import('./backends/indexeddb.js').then(m => new m.IndexedDBStorage()));
        case 'filesystem':
            return _asyncBackend(() => import('./backends/filesystem.js').then(m => new m.FileSystemStorage(storagePath || '.memory')));
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

    const methods = ['init', 'read', 'write', 'delete', 'exists', 'ls', 'search', 'getTree', 'rebuildTree', 'exportAll', 'clear'];
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
export { createOpenAIClient } from './llm/openai.js';
export { createAnthropicClient } from './llm/anthropic.js';
export { InMemoryStorage } from './backends/ram.js';
export { BaseStorage } from './backends/BaseStorage.js';
export { MemoryBulletIndex } from './bullets/bulletIndex.js';
export { MemoryRetriever } from './engine/retriever.js';
export { MemoryIngester } from './engine/ingester.js';
export { MemoryCompactor } from './engine/compactor.js';
export { createRetrievalExecutors, createExtractionExecutors } from './engine/executors.js';
export { serialize, deserialize, toZip } from './utils/portability.js';
export {
    extractSessionsFromOAFastchatExport,
    extractConversationFromOAFastchatExport,
    listOAFastchatSessions
} from './imports/oaFastchat.js';

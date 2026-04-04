/**
 * @openanonymity/memory — LLM-driven personal memory.
 *
 * createMemory(config) is the main entry point.
 *
 * Returned object has three named groups:
 *
 *   Engine   (LLM-driven):  init, retrieve, extract, compact
 *   Backends (storage ops): mem.storage.{ read, write, delete, exists,
 *                                           search, ls, getIndex,
 *                                           rebuildIndex, exportAll }
 *   Utilities  (portability): mem.serialize(), mem.toZip()
 */

import { createOpenAIClient } from './llm/openai.js';
import { createAnthropicClient } from './llm/anthropic.js';
import { MemoryBulletIndex } from './bullets/bulletIndex.js';
import { MemoryRetrieval } from './engine/retrieval.js';
import { MemoryExtractor } from './engine/extractor.js';
import { MemoryCompactor } from './engine/compactor.js';
import { InMemoryStorage } from './backends/ram.js';
import { serialize, toZip } from './utils/portability.js';

/**
 * Create a memory instance.
 *
 * @param {object} config
 * @param {object} [config.llm] — { apiKey, baseUrl, model, provider?, headers? }
 * @param {object} [config.llmClient] — custom LLM client (overrides config.llm)
 * @param {string} [config.model] — model ID (can also be set in config.llm.model)
 * @param {string|object} [config.storage='ram'] — 'ram' | 'filesystem' | 'indexeddb' | custom backend
 * @param {string} [config.storagePath] — root directory for filesystem backend
 * @param {Function} [config.onProgress] — retrieval progress callback({ stage, message, ... })
 * @param {Function} [config.onToolCall] — extraction tool call callback(name, args, result)
 * @param {Function} [config.onModelText] — intermediate model text callback(text)
 */
export function createMemory(config = {}) {
    const llmClient = config.llmClient || _createLlmClient(config.llm || {});
    const model = config.model || config.llm?.model || 'gpt-4o';
    const backend = _createBackend(config.storage, config.storagePath);
    const bulletIndex = new MemoryBulletIndex(backend);

    const retrieval = new MemoryRetrieval({
        backend, bulletIndex, llmClient, model,
        onProgress: config.onProgress,
        onModelText: config.onModelText,
    });
    const extractor = new MemoryExtractor({
        backend, bulletIndex, llmClient, model,
        onToolCall: config.onToolCall,
    });
    const compactor = new MemoryCompactor({ backend, bulletIndex, llmClient, model });

    async function write(path, content) {
        await backend.write(path, content);
        await bulletIndex.refreshPath(path);
    }

    async function remove(path) {
        await backend.delete(path);
        await bulletIndex.refreshPath(path);
    }

    async function rebuildIndex() {
        await backend.rebuildIndex();
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
         * @param {string} [conversationText] — current session text for reference resolution
         * @returns {Promise<{files, paths, assembledContext}|null>}
         */
        retrieve: (query, conversationText) => retrieval.retrieveForQuery(query, conversationText),

        /**
         * Extract facts from a conversation into memory.
         * @param {Array<{role: string, content: string}>} messages
         * @returns {Promise<{status: string, writeCalls: number}>}
         */
        extract: (messages) => extractor.extract(messages),

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
            getIndex:     ()              => backend.getIndex(),
            rebuildIndex: ()              => rebuildIndex(),
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

function _createLlmClient(llmConfig) {
    const { apiKey, baseUrl, headers, provider } = llmConfig;
    if (!apiKey) {
        throw new Error('createMemory: config.llm.apiKey is required (or provide config.llmClient)');
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
            return _asyncBackend(() => import('./backends/indexeddb.js').then(m => new m.MemoryFileSystem()));
        case 'filesystem':
            return _asyncBackend(() => import('./backends/filesystem.js').then(m => new m.FileSystemStorage(storagePath)));
        case 'ram':
        default:
            return new InMemoryStorage();
    }
}

/**
 * Wraps an async backend loader into a synchronous proxy.
 * Defers dynamic import() to the first method call.
 */
function _asyncBackend(loader) {
    let _backend = null;
    let _loading = null;

    async function resolve() {
        if (_backend) return _backend;
        if (!_loading) _loading = loader().then(b => { _backend = b; return b; });
        return _loading;
    }

    const methods = ['init', 'read', 'write', 'delete', 'exists', 'ls', 'search', 'getIndex', 'rebuildIndex', 'exportAll', 'clear'];
    const proxy = {};
    for (const method of methods) {
        proxy[method] = async (...args) => (await resolve())[method](...args);
    }
    return proxy;
}

// ─── Re-exports ──────────────────────────────────────────────────

export { createOpenAIClient } from './llm/openai.js';
export { createAnthropicClient } from './llm/anthropic.js';
export { InMemoryStorage } from './backends/ram.js';
export { BaseStorage } from './backends/BaseStorage.js';
export { MemoryBulletIndex } from './bullets/bulletIndex.js';
export { MemoryRetrieval } from './engine/retrieval.js';
export { MemoryExtractor } from './engine/extractor.js';
export { MemoryCompactor } from './engine/compactor.js';
export { createRetrievalExecutors, createExtractionExecutors } from './engine/executors.js';
export { serialize, deserialize, toZip } from './utils/portability.js';
export {
    extractSessionsFromOAFastchatExport,
    extractConversationFromOAFastchatExport,
    listOAFastchatSessions
} from './imports/oaFastchat.js';

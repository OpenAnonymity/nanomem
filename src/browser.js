/**
 * Browser-safe nanomem entrypoint.
 *
 * This mirrors createMemoryBank from index.js but excludes the filesystem
 * backend so browser bundlers do not try to resolve node:* imports.
 */
/** @import { MemoryBank, MemoryBankConfig, MemoryBankLLMConfig, Message, IngestOptions, AugmentQueryResult, RetrievalResult, StorageBackend } from './types.js' */

import { createOpenAIClient } from './llm/openai.js';
import { createAnthropicClient } from './llm/anthropic.js';
import { createTinfoilClient } from './llm/tinfoil.js';
import { MemoryBulletIndex } from './bullets/bulletIndex.js';
import { MemoryRetriever } from './engine/retriever.js';
import { MemoryIngester } from './engine/ingester.js';
import { MemoryCompactor } from './engine/compactor.js';
import { InMemoryStorage } from './backends/ram.js';
import { importData as importMemoryData } from './imports/importData.js';
import { serialize, toZip } from './utils/portability.js';
import { buildOmfExport, previewOmfImport, importOmf, parseOmfText, validateOmf } from './omf.js';

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
 * @param {MemoryBankConfig} [config]
 * @returns {MemoryBank}
 */
export function createMemoryBank(config = {}) {
    const llmClient = config.llmClient || createBrowserLlmClient(config.llm);
    const model = config.model || config.llm?.model || 'gpt-4o';
    const backend = createBrowserBackend(config.storage);
    const bulletIndex = new MemoryBulletIndex(backend);

    const retrieval = new MemoryRetriever({
        backend,
        bulletIndex,
        llmClient,
        model,
        onProgress: config.onProgress,
        onModelText: config.onModelText
    });
    const ingester = new MemoryIngester({
        backend,
        bulletIndex,
        llmClient,
        model,
        onToolCall: config.onToolCall
    });
    const compactor = new MemoryCompactor({
        backend,
        bulletIndex,
        llmClient,
        model,
        onProgress: config.onCompactProgress
    });

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

    return {
        init: () => backend.init(),
        retrieve: (query, conversationText) => retrieval.retrieveForQuery(query, conversationText),
        augmentQuery: (query, conversationText) => retrieval.augmentQueryForPrompt(query, conversationText),
        ingest: (messages, options) => ingester.ingest(messages, options),
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
        compact: () => compactor.compactAll(),
        storage: {
            read: (path) => backend.read(path),
            resolvePath: (path) => backend.resolvePath ? backend.resolvePath(path) : Promise.resolve(null),
            write: (path, content) => write(path, content),
            delete: (path) => remove(path),
            exists: (path) => backend.exists(path),
            search: (query) => backend.search(query),
            ls: (dirPath) => backend.ls(dirPath),
            getTree: () => backend.getTree(),
            rebuildTree: () => rebuildTree(),
            exportAll: () => backend.exportAll(),
            clear: () => backend.clear()
        },
        serialize: async () => serialize(await backend.exportAll()),
        toZip: async () => toZip(await backend.exportAll()),
        _backend: backend,
        _bulletIndex: bulletIndex
    };
}

function createBrowserLlmClient(llmConfig = /** @type {MemoryBankLLMConfig} */ ({ apiKey: '' })) {
    const { apiKey, baseUrl, headers, provider } = llmConfig;
    if (!apiKey) {
        throw new Error('createMemoryBank: config.llm.apiKey is required (or provide config.llmClient)');
    }

    const detectedProvider = provider || detectProvider(baseUrl);
    if (detectedProvider === 'anthropic') {
        return createAnthropicClient({ apiKey, baseUrl, headers });
    }
    if (detectedProvider === 'tinfoil') {
        return createTinfoilClient(llmConfig);
    }
    return createOpenAIClient({ apiKey, baseUrl, headers });
}

function detectProvider(baseUrl) {
    if (!baseUrl) return 'openai';
    const lower = baseUrl.toLowerCase();
    if (lower.includes('anthropic.com')) return 'anthropic';
    if (lower.includes('tinfoil.sh')) return 'tinfoil';
    return 'openai';
}

function createBrowserBackend(storage) {
    if (storage && typeof storage === 'object' && typeof storage.read === 'function') {
        return storage;
    }

    const storageType = typeof storage === 'string' ? storage : 'ram';
    switch (storageType) {
        case 'indexeddb':
            return asyncBackend(() => import('./backends/indexeddb.js').then((module) => new module.IndexedDBStorage()));
        case 'filesystem':
            throw new Error('createMemoryBank(browser): filesystem storage is not available in the browser entrypoint.');
        case 'ram':
        default:
            return new InMemoryStorage();
    }
}

function asyncBackend(loader) {
    let backend = null;
    let loading = null;

    async function resolve() {
        if (backend) return backend;
        if (!loading) {
            loading = loader().then((instance) => {
                backend = instance;
                return backend;
            });
        }
        return loading;
    }

    const methods = ['init', 'read', 'resolvePath', 'write', 'delete', 'exists', 'ls', 'search', 'getTree', 'rebuildTree', 'exportAll', 'clear'];
    const proxy = {};
    for (const method of methods) {
        proxy[method] = async (...args) => {
            const resolved = await resolve();
            return resolved[method](...args);
        };
    }
    return /** @type {StorageBackend} */ (proxy);
}

export * from './types.js';
export * from './bullets/index.js';
export { buildOmfExport, previewOmfImport, importOmf, parseOmfText, validateOmf } from './omf.js';

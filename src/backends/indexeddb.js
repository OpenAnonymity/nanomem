/**
 * IndexedDBStorage — Virtual markdown filesystem backed by IndexedDB.
 *
 * Browser-only. Stores memory files in a separate 'oa-memory-fs' database.
 */
/** @import { ExportRecord, StorageMetadata } from '../types.js' */
import { BaseStorage } from './BaseStorage.js';
import { countBullets, extractTitles } from '../bullets/index.js';
import { buildTree, createBootstrapRecords } from './schema.js';

const DB_NAME = 'oa-memory-fs';
const DB_VERSION = 1;
const STORE_NAME = 'memoryFiles';

class IndexedDBStorage extends BaseStorage {
    constructor() {
        super();
        /** @type {IDBDatabase | null} */
        this.db = null;
        /** @type {Promise<IDBDatabase> | null} */
        this._initPromise = null;
    }

    /** @returns {Promise<void>} */
    async init() {
        if (this.db) return;
        if (this._initPromise) {
            await this._initPromise;
            return;
        }

        this._initPromise = /** @type {Promise<IDBDatabase>} */ (new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = /** @type {IDBOpenDBRequest} */ (event.target).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'path' });
                    store.createIndex('parentPath', 'parentPath', { unique: false });
                }
            };

            request.onsuccess = async (event) => {
                this.db = /** @type {IDBOpenDBRequest} */ (event.target).result;
                try { await this._bootstrap(); } catch (err) {
                    console.warn('[IndexedDBStorage] Init error:', err);
                }
                try { await this.rebuildTree(); } catch (err) {
                    console.warn('[IndexedDBStorage] Tree rebuild error:', err);
                }
                resolve(/** @type {IDBDatabase} */ (this.db));
            };

            request.onerror = () => {
                this._initPromise = null;
                reject(request.error);
            };
        }));

        await this._initPromise;
    }

    async _bootstrap() {
        const all = await this._getAll();
        if (all.length > 0) return;

        const seeds = createBootstrapRecords(Date.now());
        return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const seed of seeds) store.put(seed);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    async _readRaw(path) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(path);
            request.onsuccess = () => resolve(request.result?.content ?? null);
            request.onerror = () => reject(request.error);
        });
    }

    async _writeRaw(path, content, meta = {}) {
        await this.init();
        const now = Date.now();
        const existing = await this._get(path);
        const str = String(content || '');

        const record = {
            path,
            content: str,
            oneLiner: meta.oneLiner ?? this._generateOneLiner(str),
            itemCount: meta.itemCount ?? countBullets(str),
            titles: meta.titles ?? extractTitles(str),
            parentPath: this._parentPath(path),
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };

        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    async delete(path) {
        if (this._isInternalPath(path)) return;
        await this.init();

        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(path);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
        await this.rebuildTree();
    }

    /** @returns {Promise<void>} */
    async clear() {
        await this.init();
        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readwrite');
            const request = tx.objectStore(STORE_NAME).clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        }));
        this._initPromise = null;
        await this._bootstrap();
    }

    /**
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    async exists(path) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).getKey(path);
            request.onsuccess = () => resolve(request.result !== undefined);
            request.onerror = () => reject(request.error);
        });
    }

    /** @returns {Promise<void>} */
    async rebuildTree() {
        await this.init();
        const all = this._sanitizeRecords(await this._getAll());
        const files = all
            .filter((r) => !this._isInternalPath(r.path))
            .sort((a, b) => a.path.localeCompare(b.path));
        const indexContent = buildTree(files);
        const existing = await this._get('_tree.md');
        const now = Date.now();

        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put({
                path: '_tree.md',
                content: indexContent,
                oneLiner: 'Root index of memory filesystem',
                itemCount: 0,
                titles: [],
                parentPath: '',
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    /** @returns {Promise<ExportRecord[]>} */
    async exportAll() {
        await this.init();
        return this._sanitizeRecords(await this._getAll());
    }

    // ─── Internal IndexedDB helpers ──────────────────────────────

    async _get(path) {
        return new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(path);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(request.error);
        });
    }

    async _getAll() {
        return new Promise((resolve, reject) => {
            const tx = /** @type {IDBDatabase} */ (this.db).transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    _sanitizeRecords(records) {
        return (records || [])
            .filter((record) => typeof record?.path === 'string' && record.path.trim())
            .map((record) => ({
                ...record,
                path: record.path.trim()
            }))
            .filter((record) => this._isInternalPath(record.path) || typeof record?.content === 'string');
    }
}

export { IndexedDBStorage };

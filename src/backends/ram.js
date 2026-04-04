/**
 * InMemoryStorage — In-memory (RAM) storage backend for testing.
 *
 * Data is lost when the process exits.
 */
import { BaseStorage } from './BaseStorage.js';
import { countMemoryBullets, extractMemoryTitles } from '../bullets/index.js';
import { buildMemoryIndex, createBootstrapRecords } from './schema.js';

class InMemoryStorage extends BaseStorage {
    constructor() {
        super();
        this._files = new Map();
        this._initialized = false;
    }

    async init() {
        if (this._initialized) return;
        this._initialized = true;

        if (this._files.size === 0) {
            const seeds = createBootstrapRecords(Date.now());
            for (const seed of seeds) {
                this._files.set(seed.path, seed);
            }
        }

    }

    async _readRaw(path) {
        await this.init();
        return this._files.get(path)?.content ?? null;
    }

    async _writeRaw(path, content, meta = {}) {
        await this.init();
        const now = Date.now();
        const existing = this._files.get(path);
        const str = String(content || '');

        this._files.set(path, {
            path,
            content: str,
            l0: meta.l0 ?? this._generateL0(str),
            itemCount: meta.itemCount ?? countMemoryBullets(str),
            titles: meta.titles ?? extractMemoryTitles(str),
            parentPath: this._parentPath(path),
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        });
    }

    async delete(path) {
        if (this._isInternalPath(path)) return;
        await this.init();
        this._files.delete(path);
        await this.rebuildIndex();
    }

    async clear() {
        this._files.clear();
        this._initialized = false;
        await this.init();
    }

    async exists(path) {
        await this.init();
        return this._files.has(path);
    }

    async rebuildIndex() {
        await this.init();
        const files = [...this._files.values()]
            .filter(r => !this._isInternalPath(r.path))
            .sort((a, b) => a.path.localeCompare(b.path));
        const indexContent = buildMemoryIndex(files);
        const existing = this._files.get('_index.md');
        const now = Date.now();

        this._files.set('_index.md', {
            path: '_index.md',
            content: indexContent,
            l0: 'Root index of memory filesystem',
            itemCount: 0,
            titles: [],
            parentPath: '',
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        });
    }

    async exportAll() {
        await this.init();
        return [...this._files.values()];
    }

    async _listAllPaths() {
        await this.init();
        return [...this._files.keys()].filter(p => !this._isInternalPath(p));
    }
}

export { InMemoryStorage };

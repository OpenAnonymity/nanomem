/** @import { Bullet, BulletItem, StorageBackend } from '../types.js' */
import { parseBullets, todayIsoDate } from './index.js';

class MemoryBulletIndex {
    /**
     * @param {StorageBackend} backend
     */
    constructor(backend) {
        this._backend = backend;
        this._initialized = false;
        this._initPromise = null;
        this._pathToBullets = new Map();
        this._pathToUpdatedAt = new Map();
    }

    /** @returns {Promise<void>} */
    async init() {
        if (this._initialized) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._rebuild();
        await this._initPromise;
    }

    /** @returns {Promise<void>} */
    async rebuild() {
        this._initialized = false;
        this._initPromise = this._rebuild();
        await this._initPromise;
    }

    async _rebuild() {
        await this._backend.init();
        const all = await this._backend.exportAll();
        this._pathToBullets.clear();
        this._pathToUpdatedAt.clear();

        for (const file of all) {
            if (file.path.endsWith('_tree.md')) continue;
            const bullets = this._parseForIndex(file.path, file.content || '');
            this._pathToBullets.set(file.path, bullets);
            this._pathToUpdatedAt.set(file.path, file.updatedAt || Date.now());
        }

        this._initialized = true;
        this._initPromise = null;
    }

    _parseForIndex(path, content) {
        const parsed = parseBullets(content || '');
        if (parsed.length > 0) return parsed;

        // Lightweight fallback for legacy files: use plain lines as bullets.
        const lines = String(content || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !line.startsWith('#'))
            .filter((line) => !/^_no entries yet\._$/i.test(line))
            .slice(0, 200);

        const today = todayIsoDate();
        return lines.map((line) => ({
            text: line,
            topic: path.split('/')[0] || 'general',
            updatedAt: today,
            expiresAt: null,
            reviewAt: null,
            tier: 'long_term',
            status: 'active',
            source: null,
            confidence: null,
            explicitTier: false,
            explicitStatus: false,
            explicitSource: false,
            explicitConfidence: false,
            heading: 'General',
            section: 'long_term',
            lineIndex: 0
        }));
    }

    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    async refreshPath(path) {
        await this.init();
        if (!path || path.endsWith('_tree.md')) return;

        const content = await this._backend.read(path);
        if (content === null) {
            this._pathToBullets.delete(path);
            this._pathToUpdatedAt.delete(path);
            return;
        }

        const bullets = this._parseForIndex(path, content);
        this._pathToBullets.set(path, bullets);
        this._pathToUpdatedAt.set(path, Date.now());
    }

    /**
     * @param {string[]} paths
     * @returns {BulletItem[]}
     */
    getBulletsForPaths(paths) {
        if (!this._initialized) return [];
        const items = [];
        for (const path of paths || []) {
            const bullets = this._pathToBullets.get(path);
            if (!bullets || bullets.length === 0) continue;
            for (const bullet of bullets) {
                items.push({
                    path,
                    bullet,
                    fileUpdatedAt: this._pathToUpdatedAt.get(path) || 0
                });
            }
        }
        return items;
    }
}

export { MemoryBulletIndex };

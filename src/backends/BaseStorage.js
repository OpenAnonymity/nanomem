/**
 * BaseStorage — Abstract storage backend interface.
 *
 * Subclasses must implement:
 *   init()                            → void
 *   _readRaw(path)                    → string|null
 *   _writeRaw(path, content, meta)    → void
 *   delete(path)                      → void
 *   exists(path)                      → boolean
 *   rebuildTree()                    → void         (regenerate _tree.md)
 *   exportAll()                       → [{path, content, ...}]
 *
 * BaseStorage provides (NOT abstract — do not override):
 *   read(path)           → _readRaw
 *   write(path, content) → metadata generation + _writeRaw + rebuildTree
 *
 * BaseStorage also provides default implementations for:
 *   search(query)   → [{path, snippet}]
 *   ls(dirPath)     → {files: string[], dirs: string[]}
 *   getTree()      → string
 */
/** @import { ExportRecord, ListResult, SearchResult, StorageMetadata } from '../types.js' */
import { parseBullets, extractTitles, countBullets } from '../bullets/index.js';

export class BaseStorage {

    // ─── Abstract (backends must implement) ─────────────────────

    /** @returns {Promise<void>} */ async init() { throw new Error('BaseStorage.init() not implemented'); }
    /** @returns {Promise<string | null>} */ async _readRaw(_path) { throw new Error('BaseStorage._readRaw() not implemented'); }
    async _writeRaw(_path, _content, _meta) { throw new Error('BaseStorage._writeRaw() not implemented'); }
    /** @param {string} _path @returns {Promise<void>} */ async delete(_path) { throw new Error('BaseStorage.delete() not implemented'); }
    /** @param {string} _path @returns {Promise<boolean>} */ async exists(_path) { throw new Error('BaseStorage.exists() not implemented'); }
    /** @returns {Promise<void>} */ async rebuildTree() { throw new Error('BaseStorage.rebuildTree() not implemented'); }
    /** @returns {Promise<ExportRecord[]>} */ async exportAll() { throw new Error('BaseStorage.exportAll() not implemented'); }
    /** @returns {Promise<void>} */ async clear() { throw new Error('BaseStorage.clear() not implemented'); }

    // ─── Provided: read/write ───────────────────────────────────

    /**
     * @param {string} path
     * @returns {Promise<string | null>}
     */
    async read(path) {
        return this._readRaw(path);
    }

    /**
     * @param {string} path
     * @param {string} content
     * @returns {Promise<void>}
     */
    async write(path, content) {
        if (this._isInternalPath(path)) {
            await this._writeRaw(path, String(content || ''), {});
            return;
        }
        const str = String(content || '');
        const meta = {
            oneLiner: this._generateOneLiner(str),
            itemCount: countBullets(str),
            titles: extractTitles(str),
        };
        await this._writeRaw(path, str, meta);
        await this.rebuildTree();
    }

    // ─── Shared: getTree, search, ls ───────────────────────────

    /** @returns {Promise<string | null>} */
    async getTree() {
        return this.read('_tree.md');
    }

    /**
     * @param {string} query
     * @returns {Promise<SearchResult[]>}
     */
    async search(query) {
        if (!query?.trim()) return [];
        const lowerQuery = query.toLowerCase();
        const all = await this.exportAll();
        const results = [];

        for (const rec of all) {
            if (this._isInternalPath(rec.path)) continue;
            const content = rec.content || '';
            if (!content.toLowerCase().includes(lowerQuery)) continue;

            // Return all lines that contain the query
            const matchingLines = content.split('\n')
                .filter(line => line.toLowerCase().includes(lowerQuery))
                .map(line => line.trim())
                .filter(Boolean);

            results.push({
                path: rec.path,
                lines: matchingLines,
            });
        }

        return results;
    }

    /**
     * @param {string} [dirPath]
     * @returns {Promise<ListResult>}
     */
    async ls(dirPath) {
        const allPaths = await this._listAllPaths();
        const prefix = dirPath ? dirPath + '/' : '';
        const files = [];
        const dirSet = new Set();

        for (const filePath of allPaths) {
            if (this._isInternalPath(filePath)) continue;
            if (prefix && !filePath.startsWith(prefix)) continue;
            const relative = filePath.slice(prefix.length);
            if (!relative.includes('/')) {
                files.push(filePath);
            } else {
                dirSet.add(relative.split('/')[0]);
            }
        }

        return { files, dirs: [...dirSet] };
    }

    // ─── Shared helpers ──────────────────────────────────────────

    _isInternalPath(path) {
        return path === '_tree.md';
    }

    /** Override for efficient path listing. Default uses exportAll(). */
    async _listAllPaths() {
        const all = await this.exportAll();
        return all.map(r => r.path);
    }

    _parentPath(filePath) {
        const lastSlash = filePath.lastIndexOf('/');
        return lastSlash === -1 ? '' : filePath.slice(0, lastSlash);
    }

    /** Generate a one-line summary of file content for the index. */
    _generateOneLiner(content) {
        if (!content) return '';

        const bullets = parseBullets(content);
        if (bullets.length > 0) {
            const factTexts = bullets
                .filter(b => b.section !== 'archive')
                .slice(0, 4)
                .map(b => b.text.trim())
                .filter(Boolean);
            if (factTexts.length > 0) {
                const joined = factTexts.join('; ');
                return joined.length > 120 ? joined.slice(0, 117) + '...' : joined;
            }
        }

        const titles = extractTitles(content);
        if (titles.length > 0) {
            const joined = titles.join('; ');
            return joined.length > 120 ? joined.slice(0, 117) + '...' : joined;
        }

        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
        }
        return content.slice(0, 120);
    }
}

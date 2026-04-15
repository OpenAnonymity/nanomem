/**
 * FileSystemStorage — Node.js filesystem storage backend.
 *
 * Stores memory files as .md files on disk. Uses fs/promises (Node 18+).
 */
/** @import { ExportRecord, StorageMetadata } from '../../types.js' */
import { readdir, readFile, writeFile, unlink, mkdir, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { BaseStorage } from './BaseStorage.js';
import { countBullets } from '../format/index.js';
import { buildTree, createBootstrapRecords } from './schema.js';

class FileSystemStorage extends BaseStorage {
    constructor(rootDir) {
        super();
        if (!rootDir) throw new Error('FileSystemStorage requires a rootDir');
        this._root = rootDir;
        this._initialized = false;
    }

    async init() {
        if (this._initialized) return;
        this._initialized = true;

        await mkdir(this._root, { recursive: true });

        const entries = await this._walkFiles();
        if (entries.length === 0) {
            const seeds = createBootstrapRecords(Date.now());
            for (const seed of seeds) {
                await this._writeRaw(seed.path, seed.content || '');
            }
        }

    }

    async _readRaw(path) {
        await this.init();
        try {
            return await readFile(this._resolve(path), 'utf-8');
        } catch (err) {
            if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null;
            throw err;
        }
    }

    async _writeRaw(path, content, _meta = {}) {
        const fullPath = this._resolve(path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, String(content || ''), 'utf-8');
    }

    /**
     * @param {string} path
     * @returns {Promise<void>}
     */
    async delete(path) {
        if (this._isInternalPath(path)) return;
        await this.init();
        try {
            await unlink(this._resolve(path));
        } catch (err) {
            if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err;
        }
        await this.rebuildTree();
    }

    async clear() {
        await rm(this._root, { recursive: true, force: true });
        this._initialized = false;
        await this.init();
    }

    /**
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    async exists(path) {
        await this.init();
        try {
            await stat(this._resolve(path));
            return true;
        } catch {
            return false;
        }
    }

    async rebuildTree() {
        await this.init();
        const allFiles = await this._walkFiles();
        const files = allFiles.filter((f) => !this._isInternalPath(f)).sort();
        const fileRecords = [];

        for (const filePath of files) {
            const content = await this.read(filePath);
            let updatedAt = Date.now();
            try {
                const s = await stat(this._resolve(filePath));
                updatedAt = s.mtimeMs;
            } catch { /* skip */ }
            fileRecords.push({
                path: filePath,
                itemCount: countBullets(content || ''),
                oneLiner: this._generateOneLiner(content || ''),
                updatedAt,
            });
        }

        await this._writeRaw('_tree.md', buildTree(fileRecords));
    }

    /** @returns {Promise<ExportRecord[]>} */
    async exportAll() {
        await this.init();
        const allFiles = await this._walkFiles();
        const records = [];

        for (const filePath of allFiles) {
            const content = await this.read(filePath) || '';
            let updatedAt = Date.now();
            try {
                const s = await stat(this._resolve(filePath));
                updatedAt = s.mtimeMs;
            } catch { /* skip */ }
            records.push({
                path: filePath,
                content,
                oneLiner: this._generateOneLiner(content),
                itemCount: countBullets(content),
                updatedAt,
            });
        }

        return records;
    }

    async _listAllPaths() {
        await this.init();
        return (await this._walkFiles()).filter((p) => !this._isInternalPath(p));
    }

    // ─── Internal helpers ────────────────────────────────────────

    _resolve(path) {
        return join(this._root, path);
    }

    async _ensureDir(dirPath) {
        await mkdir(join(this._root, dirPath), { recursive: true });
    }

    async _walkFiles(dir = '') {
        const results = [];
        const fullDir = dir ? join(this._root, dir) : this._root;

        let entries;
        try {
            entries = await readdir(fullDir, { withFileTypes: true });
        } catch {
            return results;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const relPath = dir ? `${dir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                results.push(...await this._walkFiles(relPath));
            } else if (entry.name.endsWith('.md')) {
                results.push(relPath);
            }
        }

        return results;
    }
}

export { FileSystemStorage };

/** @import { ExportRecord, OmfDocument, OmfImportOptions, OmfImportPreview, OmfImportResult, StorageFacade } from './types.js' */

import {
    parseBullets,
    inferTopicFromPath,
    isExpiredBullet,
    todayIsoDate,
    ensureBulletMetadata,
    compactBullets,
    renderCompactedDocument,
    normalizeFactText,
} from './bullets/index.js';

const SUPPORTED_OMF_VERSIONS = ['1.0'];
const DEFAULT_SOURCE_APP = 'nanomem';

function categoryFromPath(filePath) {
    if (!filePath) return null;
    let category = filePath.replace(/\.md$/i, '');
    category = category.replace(/\/about$/, '');
    return category || null;
}

function targetPathForItem(item) {
    const appExtensions = item.extensions?.['oa-chat'] || item.extensions?.nanomem || null;
    if (appExtensions?.file_path) {
        return appExtensions.file_path;
    }

    if (item.category) {
        const category = String(item.category).replace(/^\/+|\/+$/g, '').trim();
        if (category) {
            if (category.includes('/')) {
                return `${category}.md`;
            }
            return `${category}/about.md`;
        }
    }

    return 'personal/imported.md';
}

function isDocumentItem(item) {
    const extensions = item.extensions?.['oa-chat'] || item.extensions?.nanomem || null;
    if (extensions?.document) return true;
    return item.content.length > 500 && item.content.includes('\n');
}

function statusToSection(status) {
    if (status === 'archived' || status === 'expired') return 'history';
    return 'long_term';
}

/**
 * @param {unknown} doc
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateOmf(doc) {
    if (!doc || typeof doc !== 'object') {
        return { valid: false, error: 'Not a valid JSON object' };
    }
    const d = /** @type {any} */ (doc);
    if (!d.omf) {
        return { valid: false, error: 'Missing "omf" version field. Is this an OMF file?' };
    }
    if (!SUPPORTED_OMF_VERSIONS.includes(String(d.omf))) {
        return {
            valid: false,
            error: `Unsupported OMF version "${d.omf}". Supported: ${SUPPORTED_OMF_VERSIONS.join(', ')}`
        };
    }
    if (!Array.isArray(d.memories)) {
        return { valid: false, error: 'Missing or invalid "memories" array' };
    }
    for (let index = 0; index < d.memories.length; index += 1) {
        const memory = d.memories[index];
        if (!memory || typeof memory !== 'object') {
            return { valid: false, error: `Memory item at index ${index} is not an object` };
        }
        if (!memory.content || typeof memory.content !== 'string' || !memory.content.trim()) {
            return { valid: false, error: `Memory item at index ${index} has empty or missing "content"` };
        }
    }
    return { valid: true };
}

/**
 * @param {string} text
 * @returns {OmfDocument}
 */
export function parseOmfText(text) {
    return JSON.parse(text);
}

/**
 * @param {StorageFacade} storage
 * @param {{ sourceApp?: string }} [options]
 * @returns {Promise<OmfDocument>}
 */
export async function buildOmfExport(storage, options = {}) {
    const allFiles = await storage.exportAll();
    const today = todayIsoDate();
    const memories = [];

    for (const file of allFiles) {
        if (file.path.endsWith('_tree.md')) continue;
        if (!file.content?.trim()) continue;

        const category = categoryFromPath(file.path);
        const bullets = parseBullets(file.content);

        if (bullets.length > 0) {
            for (const bullet of bullets) {
                if (!bullet.text?.trim()) continue;

                const item = { content: bullet.text };
                if (category) item.category = category;

                const inferredTopic = inferTopicFromPath(file.path);
                if (bullet.topic && bullet.topic !== inferredTopic) {
                    item.tags = [bullet.topic];
                }

                if (isExpiredBullet(bullet, today)) {
                    item.status = 'expired';
                } else if (bullet.section === 'history' || bullet.section === 'archive') {
                    item.status = 'archived';
                }

                if (file.createdAt) {
                    item.created_at = new Date(file.createdAt).toISOString().slice(0, 10);
                }
                if (bullet.updatedAt) item.updated_at = bullet.updatedAt;
                if (bullet.expiresAt) item.expires_at = bullet.expiresAt;

                item.extensions = {
                    nanomem: {
                        file_path: file.path,
                        heading: bullet.heading || null,
                    },
                };

                memories.push(item);
            }
            continue;
        }

        const item = { content: file.content.trim() };
        if (category) item.category = category;
        if (file.createdAt) {
            item.created_at = new Date(file.createdAt).toISOString().slice(0, 10);
        }
        if (file.updatedAt) {
            item.updated_at = new Date(file.updatedAt).toISOString().slice(0, 10);
        }
        item.extensions = {
            nanomem: {
                file_path: file.path,
                document: true,
            },
        };
        memories.push(item);
    }

    return {
        omf: SUPPORTED_OMF_VERSIONS[0],
        exported_at: new Date().toISOString(),
        source: {
            app: options.sourceApp || DEFAULT_SOURCE_APP,
        },
        memories,
    };
}

/**
 * @param {StorageFacade} storage
 * @param {OmfDocument} doc
 * @param {OmfImportOptions} [options]
 * @returns {Promise<OmfImportPreview>}
 */
export async function previewOmfImport(storage, doc, options = {}) {
    const { includeArchived = true } = options;
    const validation = validateOmf(doc);
    if (!validation.valid) {
        throw new Error(validation.error);
    }

    const total = doc.memories.length;
    let filtered = 0;
    let duplicates = 0;
    const byFile = /** @type {Record<string, {new: number, duplicate: number, document?: boolean}>} */ ({});

    for (const item of doc.memories) {
        if (!includeArchived && (item.status === 'archived' || item.status === 'expired')) {
            filtered += 1;
            continue;
        }

        if (isDocumentItem(item)) {
            const path = targetPathForItem(item);
            byFile[path] = byFile[path] || { new: 0, duplicate: 0, document: true };
            byFile[path].new += 1;
            continue;
        }

        const path = targetPathForItem(item);
        byFile[path] = byFile[path] || { new: 0, duplicate: 0 };

        const existing = await storage.read(path);
        if (existing) {
            const existingBullets = parseBullets(existing);
            const normalizedNew = normalizeFactText(item.content);
            const isDuplicate = existingBullets.some((bullet) => normalizeFactText(bullet.text) === normalizedNew);
            if (isDuplicate) {
                duplicates += 1;
                byFile[path].duplicate += 1;
            } else {
                byFile[path].new += 1;
            }
        } else {
            byFile[path].new += 1;
        }
    }

    const existingFiles = new Set();
    const newFiles = new Set();
    for (const path of Object.keys(byFile)) {
        if (await storage.exists(path)) {
            existingFiles.add(path);
        } else {
            newFiles.add(path);
        }
    }

    return {
        total,
        filtered,
        toImport: total - filtered - duplicates,
        duplicates,
        newFiles: newFiles.size,
        existingFiles: existingFiles.size,
        byFile,
    };
}

/**
 * @param {StorageFacade} storage
 * @param {OmfDocument} doc
 * @param {OmfImportOptions} [options]
 * @returns {Promise<OmfImportResult>}
 */
export async function importOmf(storage, doc, options = {}) {
    const { includeArchived = true } = options;
    const validation = validateOmf(doc);
    if (!validation.valid) {
        throw new Error(validation.error);
    }

    const today = todayIsoDate();
    const errors = [];
    let skipped = 0;
    const groups = new Map();

    for (const item of doc.memories) {
        if (!includeArchived && (item.status === 'archived' || item.status === 'expired')) {
            skipped += 1;
            continue;
        }

        const path = targetPathForItem(item);
        if (!groups.has(path)) {
            groups.set(path, []);
        }
        groups.get(path).push(item);
    }

    let imported = 0;
    let duplicates = 0;
    let filesWritten = 0;

    for (const [path, items] of groups.entries()) {
        try {
            const documentItems = items.filter(isDocumentItem);
            const bulletItems = items.filter((item) => !isDocumentItem(item));
            const defaultTopic = inferTopicFromPath(path);

            if (documentItems.length > 0 && bulletItems.length === 0) {
                const documentItem = documentItems[documentItems.length - 1];
                await storage.write(path, documentItem.content);
                imported += documentItems.length;
                filesWritten += 1;
                continue;
            }

            const existing = await storage.read(path);
            const existingBullets = existing ? parseBullets(existing) : [];

            const incomingBullets = bulletItems.map((item) => ensureBulletMetadata({
                text: item.content,
                topic: item.tags?.[0] || null,
                updatedAt: item.updated_at || today,
                expiresAt: item.expires_at || null,
                section: statusToSection(item.status),
            }, { updatedAt: today, defaultTopic }));

            const existingNormalized = new Set(existingBullets.map((bullet) => normalizeFactText(bullet.text)));
            let itemDuplicates = 0;
            for (const bullet of incomingBullets) {
                if (existingNormalized.has(normalizeFactText(bullet.text))) {
                    itemDuplicates += 1;
                }
            }
            duplicates += itemDuplicates;

            const allBullets = [...existingBullets, ...incomingBullets];
            const compacted = compactBullets(allBullets, { today, defaultTopic });
            const markdown = renderCompactedDocument(
                compacted.working,
                compacted.longTerm,
                compacted.history
            );

            await storage.write(path, markdown);
            imported += bulletItems.length - itemDuplicates;
            filesWritten += 1;

            if (documentItems.length > 0) {
                imported += documentItems.length;
            }
        } catch (error) {
            errors.push(`Error writing ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return {
        total: doc.memories.length,
        imported,
        duplicates,
        skipped,
        filesWritten,
        errors,
    };
}

/**
 * Version log (vlog) — append-only audit trail for bullet mutations.
 *
 * Each memory file `<path>.md` has a companion `_vlog/<path>.jsonl` that
 * records every mutation (confidence change, content replacement, deletion).
 * The vlog is never touched by compaction, so lineage survives pruning of
 * the History section in the main file.
 *
 * Entry format (one JSON object per line):
 *   { id, v, event, at, confidence, prev?, text?, supersedes? }
 */
/** @import { VersionLogEntry, VlogEvent, StorageBackend } from '../types.js' */

const VLOG_PREFIX = '_vlog/';

/**
 * Maps a memory file path to its vlog path.
 * e.g. "health/asthma.md" → "_vlog/health/asthma.jsonl"
 * @param {string} memoryPath
 * @returns {string}
 */
export function vlogPath(memoryPath) {
    const base = memoryPath.replace(/\.md$/i, '');
    return `${VLOG_PREFIX}${base}.jsonl`;
}

/**
 * Returns true if a path is a vlog file (should be excluded from memory operations).
 * @param {string} path
 * @returns {boolean}
 */
export function isVlogPath(path) {
    return path.startsWith(VLOG_PREFIX);
}

/**
 * Appends a version log entry to the vlog for a memory file.
 * @param {StorageBackend} backend
 * @param {string} memoryPath
 * @param {VersionLogEntry} entry
 * @returns {Promise<void>}
 */
export async function appendVlogEntry(backend, memoryPath, entry) {
    const path = vlogPath(memoryPath);
    const existing = await backend.read(path);
    const line = JSON.stringify(entry);
    const content = existing ? `${existing}\n${line}` : line;
    await backend.write(path, content);
}

/**
 * Reads all version log entries for a memory file.
 * Returns entries in chronological order (oldest first).
 * @param {StorageBackend} backend
 * @param {string} memoryPath
 * @returns {Promise<VersionLogEntry[]>}
 */
export async function readVlog(backend, memoryPath) {
    const path = vlogPath(memoryPath);
    const content = await backend.read(path);
    if (!content) return [];
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
}

/**
 * Returns the full confidence trajectory for a given bullet ID,
 * in chronological order.
 * @param {VersionLogEntry[]} entries
 * @param {string} bulletId
 * @returns {VersionLogEntry[]}
 */
export function getTrajectory(entries, bulletId) {
    return entries.filter(e => e.id === bulletId);
}

/**
 * Builds a vlog entry for a new bullet being created.
 * @param {import('../types.js').Bullet} bullet
 * @param {string} at
 * @returns {VersionLogEntry}
 */
export function buildCreatedEntry(bullet, at) {
    return {
        id: bullet.id,
        v: 1,
        event: 'created',
        at,
        confidence: bullet.confidence,
        text: bullet.text,
    };
}

/**
 * Builds a vlog entry for a confidence mutation on an existing bullet.
 * @param {import('../types.js').Bullet} bullet - the bullet after mutation
 * @param {number | null} prevConfidence
 * @param {VlogEvent} event
 * @param {string} at
 * @returns {VersionLogEntry}
 */
export function buildConfidenceEntry(bullet, prevConfidence, event, at) {
    return {
        id: bullet.id,
        v: bullet.v,
        event,
        at,
        confidence: bullet.confidence,
        prev: prevConfidence,
    };
}

/**
 * Builds a vlog entry for a bullet being superseded by a content update.
 * The old bullet gets a 'contradiction' entry; the new bullet gets a 'content_update' entry.
 * @param {import('../types.js').Bullet} newBullet - the replacement bullet
 * @param {string} oldId - ID of the bullet being replaced
 * @param {number} oldBulletV - current version of the old bullet (before this mutation)
 * @param {number | null} oldConfidence
 * @param {string} at
 * @returns {{ oldEntry: VersionLogEntry, newEntry: VersionLogEntry }}
 */
export function buildContentUpdateEntries(newBullet, oldId, oldBulletV, oldConfidence, at) {
    return {
        oldEntry: {
            id: oldId,
            v: oldBulletV + 1,
            event: 'contradiction',
            at,
            confidence: newBullet.prevConfidence,
            prev: oldConfidence,
        },
        newEntry: {
            id: newBullet.id,
            v: newBullet.v,
            event: 'content_update',
            at,
            confidence: newBullet.confidence,
            text: newBullet.text,
            supersedes: oldId,
        },
    };
}

/**
 * Builds a vlog entry for a bullet being deleted.
 * @param {import('../types.js').Bullet} bullet
 * @param {string} at
 * @returns {VersionLogEntry}
 */
export function buildDeletedEntry(bullet, at) {
    return {
        id: bullet.id,
        v: bullet.v + 1,
        event: 'deleted',
        at,
        confidence: bullet.confidence,
    };
}

/**
 * Returns the current version number for a bullet by reading its vlog.
 * Returns 1 if the bullet has no vlog entries yet.
 * @param {StorageBackend} backend
 * @param {string} memoryPath
 * @param {string} bulletId
 * @returns {Promise<number>}
 */
export async function getCurrentV(backend, memoryPath, bulletId) {
    const entries = await readVlog(backend, memoryPath);
    let maxV = 0;
    for (const entry of entries) {
        if (entry.id === bulletId && Number.isFinite(entry.v) && entry.v > maxV) {
            maxV = entry.v;
        }
    }
    return maxV || 1;
}

/**
 * Compares bullets before and after compaction (by ID) and returns vlog entries
 * for any confidence mutations that compaction introduced.
 *
 * @param {import('../types.js').Bullet[]} before - bullets parsed before compaction
 * @param {import('../types.js').Bullet[]} after - bullets parsed after compaction
 * @param {string} at
 * @param {VersionLogEntry[]} existingVlog - existing vlog entries used to derive current v
 * @returns {VersionLogEntry[]}
 */
export function detectCompactionMutations(before, after, at, existingVlog = []) {
    const maxVById = new Map();
    for (const entry of existingVlog) {
        if (entry.id && Number.isFinite(entry.v)) {
            const cur = maxVById.get(entry.id) || 0;
            if (entry.v > cur) maxVById.set(entry.id, entry.v);
        }
    }

    const beforeById = new Map(before.filter(b => b.id).map(b => [b.id, b]));
    const afterById = new Map(after.filter(b => b.id).map(b => [b.id, b]));
    const entries = [];

    for (const [id, afterBullet] of afterById) {
        const beforeBullet = beforeById.get(id);
        if (!beforeBullet) continue;

        const prevConf = beforeBullet.confidence;
        const nextConf = afterBullet.confidence;
        if (prevConf === nextConf) continue;

        const movedToHistory = afterBullet.section === 'history' && beforeBullet.section !== 'history';
        const event = movedToHistory ? 'tier_transition' : 'compaction';
        const beforeV = Number.isFinite(beforeBullet.v) ? beforeBullet.v : 1;
        const afterV = Number.isFinite(afterBullet.v) ? afterBullet.v : 1;
        const vlogV = maxVById.get(id) || 1;
        const currentV = Math.max(beforeV, afterV, vlogV, 1);

        entries.push({
            id,
            v: currentV + 1,
            event,
            at,
            confidence: nextConf,
            prev: prevConf,
        });
    }

    return entries;
}

/**
 * Emit 'created' vlog entries for bullets that appear in `after` but not in `before`.
 * This transparently bootstraps versioning for legacy bullets receiving IDs during a write.
 * Skips history bullets and any ID already present in the vlog.
 *
 * @param {StorageBackend} backend
 * @param {string} memoryPath
 * @param {import('../types.js').Bullet[]} before - parsed bullets before the write
 * @param {import('../types.js').Bullet[]} after - parsed bullets after the write
 * @param {string} at - ISO datetime
 * @returns {Promise<void>}
 */
export async function bootstrapCreatedEntries(backend, memoryPath, before, after, at) {
    const beforeIds = new Set(before.filter((b) => b.id).map((b) => b.id));
    const newBullets = after.filter((b) => b.id && !beforeIds.has(b.id) && b.section !== 'history');
    if (newBullets.length === 0) return;

    const existingVlog = await readVlog(backend, memoryPath);
    const loggedIds = new Set(existingVlog.map((e) => e.id));

    for (const bullet of newBullets) {
        if (loggedIds.has(bullet.id)) continue;
        await appendVlogEntry(backend, memoryPath, buildCreatedEntry(bullet, at));
    }
}

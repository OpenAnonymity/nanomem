import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapCreatedEntries, readVlog } from '../../src/internal/vlog.js';
import { parseBullets, ensureBulletMetadata } from '../../src/internal/format/index.js';

const AT = '2026-05-18T12:00:00.000Z';

function makeBackend(initial = {}) {
    const files = new Map(Object.entries(initial));
    return {
        async read(path) { return files.has(path) ? files.get(path) : null; },
        async write(path, content) { files.set(path, content); },
    };
}

function legacyBullet(text) {
    return parseBullets(`- ${text} | topic=general | tier=long_term | status=active | source=user_statement | confidence=0.8 | updated_at=2025-01-01T10:00:00.000Z`)[0];
}

function versionedBullet(text, id = 'abc12345') {
    return { ...legacyBullet(text), id, v: 1 };
}

describe('bootstrapCreatedEntries', () => {
    let backend;

    beforeEach(() => { backend = makeBackend(); });

    it('creates vlog entry for a new bullet not in before', async () => {
        const before = [];
        const after = [ensureBulletMetadata(legacyBullet('I like coffee'), {})];
        await bootstrapCreatedEntries(backend, 'personal/about.md', before, after, AT);
        const entries = await readVlog(backend, 'personal/about.md');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].event, 'created');
        assert.equal(entries[0].confidence, 0.8);
        assert.equal(entries[0].text, 'I like coffee');
    });

    it('creates entry for legacy bullet (no id in before) that gets id in after', async () => {
        const before = [legacyBullet('I like coffee')]; // id: null
        const after = [ensureBulletMetadata(legacyBullet('I like coffee'), {})]; // gets id
        await bootstrapCreatedEntries(backend, 'personal/about.md', before, after, AT);
        const entries = await readVlog(backend, 'personal/about.md');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].event, 'created');
    });

    it('skips bullets already present in the vlog', async () => {
        const bullet = ensureBulletMetadata(legacyBullet('I like coffee'), {});
        // Pre-populate vlog with this bullet's id
        backend = makeBackend({
            [`_vlog/personal/about.jsonl`]: JSON.stringify({ id: bullet.id, v: 1, event: 'corroboration', at: AT, confidence: 0.9 })
        });
        const before = [];
        const after = [bullet];
        await bootstrapCreatedEntries(backend, 'personal/about.md', before, after, AT);
        const entries = await readVlog(backend, 'personal/about.md');
        assert.equal(entries.length, 1, 'should not add a duplicate entry');
        assert.equal(entries[0].event, 'corroboration');
    });

    it('skips history-section bullets', async () => {
        const bullet = ensureBulletMetadata({ ...legacyBullet('Old fact'), section: 'history', tier: 'history', status: 'superseded' }, {});
        await bootstrapCreatedEntries(backend, 'personal/about.md', [], [bullet], AT);
        const entries = await readVlog(backend, 'personal/about.md');
        assert.equal(entries.length, 0);
    });

    it('skips bullets whose id was already in before', async () => {
        const bullet = versionedBullet('Already versioned');
        await bootstrapCreatedEntries(backend, 'personal/about.md', [bullet], [bullet], AT);
        const entries = await readVlog(backend, 'personal/about.md');
        assert.equal(entries.length, 0);
    });

    it('only bootstraps new bullets when mixed with existing versioned ones', async () => {
        const existing = versionedBullet('Already versioned');
        const legacy = ensureBulletMetadata(legacyBullet('New fact'), {});
        await bootstrapCreatedEntries(backend, 'personal/about.md', [existing], [existing, legacy], AT);
        const entries = await readVlog(backend, 'personal/about.md');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].text, 'New fact');
    });

    it('is a no-op when before and after have the same versioned bullets', async () => {
        const bullet = versionedBullet('Stable fact');
        await bootstrapCreatedEntries(backend, 'personal/about.md', [bullet], [bullet], AT);
        const entries = await readVlog(backend, 'personal/about.md');
        assert.equal(entries.length, 0);
    });
});

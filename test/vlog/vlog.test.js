import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    vlogPath,
    isVlogPath,
    appendVlogEntry,
    readVlog,
    getTrajectory,
    detectCompactionMutations,
    buildCreatedEntry,
    buildConfidenceEntry,
    buildDeletedEntry,
} from '../../src/internal/vlog.js';
import { createRetrievalExecutors, createExtractionExecutors, createDeletionExecutors } from '../../src/tools/executors.js';
import { InMemoryStorage } from '../../src/internal/storage/ram.js';
import { serialize } from '../../src/internal/portability.js';

function makeBackend(initial = {}) {
    const files = new Map(Object.entries(initial));
    return {
        files,
        async read(path) { return files.has(path) ? files.get(path) : null; },
        async write(path, content) { files.set(path, content); },
        async exists(path) { return files.has(path); },
        async delete(path) { files.delete(path); },
    };
}

describe('vlogPath', () => {
    it('maps .md to _vlog/*.jsonl', () => {
        assert.equal(vlogPath('health/asthma.md'), '_vlog/health/asthma.jsonl');
    });
    it('works for nested paths', () => {
        assert.equal(vlogPath('work/career/goals.md'), '_vlog/work/career/goals.jsonl');
    });
    it('works for top-level files', () => {
        assert.equal(vlogPath('prefs.md'), '_vlog/prefs.jsonl');
    });
});

describe('isVlogPath', () => {
    it('returns true for vlog paths', () => {
        assert.ok(isVlogPath('_vlog/health/asthma.jsonl'));
        assert.ok(isVlogPath('_vlog/prefs.jsonl'));
    });
    it('returns false for memory paths', () => {
        assert.ok(!isVlogPath('health/asthma.md'));
        assert.ok(!isVlogPath('_tree.md'));
    });
});

describe('appendVlogEntry / readVlog', () => {
    let backend;

    beforeEach(() => { backend = makeBackend(); });

    it('creates the vlog file on first append', async () => {
        const entry = { id: 'abc12345', v: 1, event: 'created', at: '2026-05-18T10:00', confidence: 0.7 };
        await appendVlogEntry(backend, 'health/asthma.md', entry);
        const entries = await readVlog(backend, 'health/asthma.md');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].id, 'abc12345');
        assert.equal(entries[0].event, 'created');
    });

    it('appends multiple entries in order', async () => {
        await appendVlogEntry(backend, 'health/asthma.md', { id: 'aaa', v: 1, event: 'created', at: '2026-05-01T10:00', confidence: 0.7 });
        await appendVlogEntry(backend, 'health/asthma.md', { id: 'aaa', v: 2, event: 'corroboration', at: '2026-05-10T10:00', confidence: 0.84, prev: 0.7 });
        await appendVlogEntry(backend, 'health/asthma.md', { id: 'aaa', v: 3, event: 'compaction', at: '2026-05-15T10:00', confidence: 0.42, prev: 0.84 });
        const entries = await readVlog(backend, 'health/asthma.md');
        assert.equal(entries.length, 3);
        assert.equal(entries[0].event, 'created');
        assert.equal(entries[1].event, 'corroboration');
        assert.equal(entries[2].event, 'compaction');
    });

    it('returns empty array when no vlog exists', async () => {
        const entries = await readVlog(backend, 'nonexistent.md');
        assert.deepEqual(entries, []);
    });
});

describe('vlog internal storage visibility', () => {
    it('keeps vlog files out of agent-visible indexes and exports', async () => {
        const storage = new InMemoryStorage();
        await storage.write('work/role.md', `# Memory: Role

## Long-term memory (stable facts that are unlikely to change)
- Works at Stripe | topic=work | tier=long_term | status=active | source=user_statement | confidence=1 | updated_at=2026-01-01T00:00 | id=role123 | v=1
`);

        await appendVlogEntry(storage, 'work/role.md', {
            id: 'role123',
            v: 2,
            event: 'deleted',
            at: '2026-05-25T10:00',
            confidence: 1
        });

        const vlogContent = await storage.read('_vlog/work/role.jsonl');
        assert.match(vlogContent, /"event":"deleted"/);

        const tree = await storage.getTree();
        assert.doesNotMatch(tree || '', /_vlog/);

        const searchResults = await storage.search('deleted');
        assert.deepEqual(searchResults, []);

        const listing = await storage.ls('');
        assert.ok(!listing.dirs.includes('_vlog'));
        assert.ok(!listing.files.some(path => path.startsWith('_vlog/')));

        const exported = await storage.exportAll();
        assert.ok(exported.some(record => record.path === '_vlog/work/role.jsonl'));
        assert.doesNotMatch(serialize(exported), /_vlog/);
    });

    it('blocks normalized internal paths from agent-facing tools', async () => {
        const storage = new InMemoryStorage();
        await storage.write('work/role.md', `# Memory: Role

## Long-term memory (stable facts that are unlikely to change)
- Works at Stripe | topic=work | tier=long_term | status=active | source=user_statement | confidence=1 | updated_at=2026-01-01T00:00 | id=role123 | v=1
`);
        await appendVlogEntry(storage, 'work/role.md', {
            id: 'role123',
            v: 2,
            event: 'deleted',
            at: '2026-05-25T10:00',
            confidence: 1
        });

        const retrieval = createRetrievalExecutors(storage);
        const extraction = createExtractionExecutors(storage);
        const deletion = createDeletionExecutors(storage);

        assert.match(await retrieval.read_file({ path: './_vlog/work/role.jsonl' }), /File not found/);
        assert.match(await retrieval.read_file({ path: 'work/../_vlog/work/role.jsonl' }), /File not found/);
        assert.match(await extraction.read_file({ path: './_vlog/work/role.jsonl' }), /File not found/);
        assert.match(await deletion.read_file({ path: './_vlog/work/role.jsonl' }), /File not found/);
        assert.match(await extraction.append_memory({ path: './_vlog/work/role.jsonl', content: '- bad' }), /Cannot write internal file/);
        assert.match(await extraction.create_new_file({ path: './_vlog/new.jsonl', content: '- bad' }), /Cannot write internal file/);
        assert.match(await extraction.delete_memory({ path: './_vlog/work/role.jsonl' }), /Cannot delete index files/);
        assert.match(await deletion.delete_bullet({ path: './_vlog/work/role.jsonl', bullet_text: 'deleted' }), /File not found/);
    });
});

describe('getTrajectory', () => {
    it('filters entries to a single bullet ID', () => {
        const entries = [
            { id: 'aaa', v: 1, event: 'created', at: '2026-05-01T10:00', confidence: 0.7 },
            { id: 'bbb', v: 1, event: 'created', at: '2026-05-01T10:00', confidence: 1.0 },
            { id: 'aaa', v: 2, event: 'corroboration', at: '2026-05-10T10:00', confidence: 0.84, prev: 0.7 },
        ];
        const traj = getTrajectory(entries, 'aaa');
        assert.equal(traj.length, 2);
        assert.ok(traj.every(e => e.id === 'aaa'));
    });
});

describe('detectCompactionMutations', () => {
    it('detects confidence decrease as tier_transition when bullet moved to history', () => {
        const before = [{ id: 'abc', v: 1, section: 'long_term', confidence: 0.7, text: 'foo' }];
        const after  = [{ id: 'abc', v: 2, section: 'history',   confidence: 0.35, text: 'foo' }];
        const entries = detectCompactionMutations(before, after, '2026-05-18T10:00');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].event, 'tier_transition');
        assert.equal(entries[0].id, 'abc');
        assert.equal(entries[0].v, 3);
        assert.equal(entries[0].prev, 0.7);
        assert.equal(entries[0].confidence, 0.35);
    });

    it('detects confidence decrease within same tier as compaction', () => {
        const before = [{ id: 'abc', v: 1, section: 'history', confidence: 0.7, text: 'foo' }];
        const after  = [{ id: 'abc', v: 2, section: 'history', confidence: 0.35, text: 'foo' }];
        const entries = detectCompactionMutations(before, after, '2026-05-18T10:00');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].event, 'compaction');
    });

    it('ignores bullets with unchanged confidence', () => {
        const before = [{ id: 'abc', v: 1, section: 'long_term', confidence: 0.7, text: 'foo' }];
        const after  = [{ id: 'abc', v: 1, section: 'long_term', confidence: 0.7, text: 'foo' }];
        assert.equal(detectCompactionMutations(before, after, '2026-05-18T10:00').length, 0);
    });

    it('ignores bullets with no ID', () => {
        const before = [{ id: null, v: 1, section: 'long_term', confidence: 0.7, text: 'foo' }];
        const after  = [{ id: null, v: 2, section: 'history',   confidence: 0.35, text: 'foo' }];
        assert.equal(detectCompactionMutations(before, after, '2026-05-18T10:00').length, 0);
    });

    it('uses stored bullet versions when no vlog entries exist', () => {
        const before = [{ id: 'abc', v: 5, section: 'long_term', confidence: 0.7, text: 'foo' }];
        const after = [{ id: 'abc', v: 5, section: 'history', confidence: 0.35, text: 'foo' }];
        const entries = detectCompactionMutations(before, after, '2026-05-18T10:00');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].v, 6);
    });

    it('uses the greatest known version from bullets and existing vlog entries', () => {
        const before = [{ id: 'abc', v: 5, section: 'long_term', confidence: 0.7, text: 'foo' }];
        const after = [{ id: 'abc', v: 6, section: 'history', confidence: 0.35, text: 'foo' }];
        const entries = detectCompactionMutations(before, after, '2026-05-18T10:00', [
            { id: 'abc', v: 8, event: 'corroboration', at: '2026-05-01T10:00', confidence: 0.7 }
        ]);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].v, 9);
    });
});

describe('vlog written by corroborate_bullet', () => {
    let backend, executors;

    beforeEach(() => {
        backend = makeBackend();
        executors = createExtractionExecutors(backend, { updatedAt: '2026-05-18T12:00' });
    });

    it('writes a corroboration vlog entry with prev confidence', async () => {
        await backend.write('health/asthma.md', `# Memory: Asthma

## Long-term memory (stable facts that are unlikely to change)
- Has asthma | topic=health | tier=long_term | status=active | source=user_statement | confidence=0.6 | updated_at=2026-01-15T08:00 | id=abc12345 | v=1
`);
        await executors.corroborate_bullet({ path: 'health/asthma.md', fact_text: 'Has asthma' });
        const entries = await readVlog(backend, 'health/asthma.md');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].id, 'abc12345');
        assert.equal(entries[0].event, 'corroboration');
        assert.equal(entries[0].v, 2);
        assert.equal(entries[0].prev, 0.6);
        assert.ok(entries[0].confidence > 0.6);
    });

    it('assigns an ID to a legacy bullet (no id field) and writes vlog entry', async () => {
        await backend.write('health/asthma.md', `# Memory: Asthma

## Long-term memory (stable facts that are unlikely to change)
- Has asthma | topic=health | tier=long_term | status=active | source=user_statement | confidence=0.6 | updated_at=2026-01-15T08:00
`);
        await executors.corroborate_bullet({ path: 'health/asthma.md', fact_text: 'Has asthma' });
        const entries = await readVlog(backend, 'health/asthma.md');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].event, 'corroboration');
        assert.ok(typeof entries[0].id === 'string' && entries[0].id.length > 0);
    });
});

describe('vlog written by update_bullets', () => {
    let backend, executors;

    beforeEach(() => {
        backend = makeBackend();
        executors = createExtractionExecutors(backend, { updatedAt: '2026-05-18T12:00' });
    });

    it('writes contradiction entry for old bullet and content_update for new bullet', async () => {
        await backend.write('work/role.md', `# Memory: Role

## Long-term memory (stable facts that are unlikely to change)
- Works at Stripe | topic=work | tier=long_term | status=active | source=user_statement | confidence=1 | updated_at=2026-01-01T00:00 | id=oldid123 | v=1
`);
        await executors.update_bullets({
            path: 'work/role.md',
            updates: [{ old_fact: 'Works at Stripe', new_fact: 'Works at Anthropic' }],
        });

        const entries = await readVlog(backend, 'work/role.md');
        assert.equal(entries.length, 2);

        const contradiction = entries.find(e => e.event === 'contradiction');
        const contentUpdate = entries.find(e => e.event === 'content_update');

        assert.ok(contradiction, 'should have a contradiction entry for the old bullet');
        assert.equal(contradiction.id, 'oldid123');

        assert.ok(contentUpdate, 'should have a content_update entry for the new bullet');
        assert.equal(contentUpdate.supersedes, 'oldid123');
        assert.equal(contentUpdate.text, 'Works at Anthropic');
        assert.ok(typeof contentUpdate.id === 'string' && contentUpdate.id !== 'oldid123');
    });

    it('new bullet carries supersedes= in the rendered file', async () => {
        await backend.write('work/role.md', `# Memory: Role

## Long-term memory (stable facts that are unlikely to change)
- Works at Stripe | topic=work | tier=long_term | status=active | source=user_statement | confidence=1 | updated_at=2026-01-01T00:00 | id=oldid123 | v=1
`);
        await executors.update_bullets({
            path: 'work/role.md',
            updates: [{ old_fact: 'Works at Stripe', new_fact: 'Works at Anthropic' }],
        });
        const content = await backend.read('work/role.md');
        assert.match(content, /supersedes=oldid123/);
    });
});

describe('vlog written by delete_bullet', () => {
    let backend, executors;

    beforeEach(() => {
        backend = makeBackend({});
        executors = createDeletionExecutors(backend, {});
    });

    it('writes a deleted vlog entry when a bullet is deleted', async () => {
        backend.files.set('work/role.md', `# Memory: Role

## Long-term memory (stable facts that are unlikely to change)
- Works at Stripe | topic=work | tier=long_term | status=active | source=user_statement | confidence=1 | updated_at=2026-01-01T00:00 | id=delid123 | v=2
`);
        await executors.delete_bullet({ path: 'work/role.md', bullet_text: 'Works at Stripe' });
        const entries = await readVlog(backend, 'work/role.md');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].event, 'deleted');
        assert.equal(entries[0].id, 'delid123');
        assert.equal(entries[0].v, 3);
    });
});

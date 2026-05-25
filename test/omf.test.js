import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOmfExport, importOmf, validateOmf } from '../src/internal/omf.js';
import { InMemoryStorage } from '../src/internal/storage/ram.js';

function makeDoc(overrides = {}) {
    return {
        omf: '1.0',
        exported_at: '2024-06-01T00:00:00.000Z',
        source: { app: 'nanomem' },
        memories: [
            { content: 'Loves hiking' },
        ],
        ...overrides,
    };
}

describe('validateOmf', () => {
    it('accepts a valid OMF document', () => {
        assert.deepEqual(validateOmf(makeDoc()), { valid: true });
    });

    it('accepts a document with multiple memories', () => {
        const doc = makeDoc({
            memories: [
                { content: 'Fact one' },
                { content: 'Fact two', category: 'hobbies' },
                { content: 'Fact three', status: 'archived' },
            ],
        });
        assert.deepEqual(validateOmf(doc), { valid: true });
    });

    it('accepts a document with an empty memories array', () => {
        assert.deepEqual(validateOmf(makeDoc({ memories: [] })), { valid: true });
    });

    it('rejects null/undefined input', () => {
        assert.equal(validateOmf(null).valid, false);
        assert.equal(validateOmf(undefined).valid, false);
        assert.equal(validateOmf('string').valid, false);
        assert.equal(validateOmf(42).valid, false);
    });

    it('rejects a document missing the omf field', () => {
        const result = validateOmf({ memories: [] });
        assert.equal(result.valid, false);
        assert.ok(result.error.includes('"omf"'));
    });

    it('rejects an unsupported OMF version', () => {
        const result = validateOmf(makeDoc({ omf: '2.0' }));
        assert.equal(result.valid, false);
        assert.ok(result.error.includes('2.0'));
    });

    it('rejects a document missing the memories array', () => {
        const result = validateOmf({ omf: '1.0' });
        assert.equal(result.valid, false);
        assert.ok(result.error.toLowerCase().includes('memories'));
    });

    it('rejects a document where memories is not an array', () => {
        const result = validateOmf(makeDoc({ memories: 'not an array' }));
        assert.equal(result.valid, false);
    });

    it('rejects a memory item that is not an object', () => {
        const result = validateOmf(makeDoc({ memories: ['just a string'] }));
        assert.equal(result.valid, false);
        assert.ok(result.error.includes('index 0'));
    });

    it('rejects a memory item with missing content', () => {
        const result = validateOmf(makeDoc({ memories: [{ category: 'work' }] }));
        assert.equal(result.valid, false);
        assert.ok(result.error.includes('index 0'));
    });

    it('rejects a memory item with empty string content', () => {
        const result = validateOmf(makeDoc({ memories: [{ content: '   ' }] }));
        assert.equal(result.valid, false);
    });

    it('identifies the correct index for an invalid item', () => {
        const result = validateOmf(makeDoc({
            memories: [
                { content: 'Valid item' },
                { content: 'Also valid' },
                { category: 'missing content' },
            ],
        }));
        assert.equal(result.valid, false);
        assert.ok(result.error.includes('index 2'));
    });
});

describe('OMF vlog round-trip', () => {
    it('canonicalizes restored vlog extension paths as internal records', async () => {
        const storage = new InMemoryStorage();
        await importOmf(storage, {
            omf: '1.0',
            exported_at: '2026-05-25T00:00:00.000Z',
            source: { app: 'nanomem' },
            memories: [
                { content: 'Works at Stripe', category: 'work' }
            ],
            extensions: {
                nanomem: {
                    vlogs: {
                        './_vlog/work/about.jsonl': '{"id":"role123","v":2,"event":"deleted"}'
                    }
                }
            }
        });

        assert.equal(await storage.read('_vlog/work/about.jsonl'), '{"id":"role123","v":2,"event":"deleted"}');
        assert.equal(await storage.read('./_vlog/work/about.jsonl'), '{"id":"role123","v":2,"event":"deleted"}');

        const all = await storage.exportAll();
        assert.ok(all.some(record => record.path === '_vlog/work/about.jsonl'));
        assert.ok(!all.some(record => record.path === './_vlog/work/about.jsonl'));

        const exported = await buildOmfExport(storage);
        assert.equal(exported.extensions.nanomem.vlogs['_vlog/work/about.jsonl'], '{"id":"role123","v":2,"event":"deleted"}');
        assert.ok(!exported.memories.some(item => item.extensions?.nanomem?.file_path === '_vlog/work/about.jsonl'));
    });
});

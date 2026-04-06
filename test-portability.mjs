import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize } from './src/utils/portability.js';

// ─── serialize → deserialize round-trips ─────────────────────────────────────

test('round-trips a single file', () => {
    const records = [{ path: 'notes.md', content: 'hello world' }];
    assert.deepEqual(deserialize(serialize(records)), records);
});

test('round-trips multiple files', () => {
    const records = [
        { path: 'a/b.md', content: 'file b' },
        { path: 'c/d/e.md', content: 'file e' },
    ];
    assert.deepEqual(deserialize(serialize(records)), records);
});

test('_tree.md is excluded from serialized output', () => {
    const records = [
        { path: 'profile.md', content: 'some facts' },
        { path: '_tree.md', content: '# Memory Index\n...' },
    ];
    const result = deserialize(serialize(records));
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'profile.md');
});

test('round-trips empty content', () => {
    const records = [{ path: 'empty.md', content: '' }];
    assert.deepEqual(deserialize(serialize(records)), records);
});

test('round-trips multi-line content', () => {
    const records = [{
        path: 'health/diet.md',
        content: '- likes pizza | topic=food\n- hates broccoli | topic=food\n',
    }];
    assert.deepEqual(deserialize(serialize(records)), records);
});

test('round-trips content with blank lines', () => {
    const records = [{
        path: 'notes.md',
        content: 'line 1\n\nline 3\n\n\nline 6',
    }];
    assert.deepEqual(deserialize(serialize(records)), records);
});

test('round-trips content containing markdown headers and bullets', () => {
    const records = [{
        path: 'profile.md',
        content: '# Profile\n\n- name: Alice\n- age: 30\n\n## Work\n\n- engineer at Acme',
    }];
    assert.deepEqual(deserialize(serialize(records)), records);
});

test('round-trips zero records', () => {
    assert.deepEqual(deserialize(serialize([])), []);
});

// ─── serialize format ─────────────────────────────────────────────────────────

test('serialize output starts with the file separator', () => {
    const out = serialize([{ path: 'foo.md', content: 'bar' }]);
    assert.ok(out.startsWith('--- FILE: foo.md\n'), `got: ${JSON.stringify(out)}`);
});

test('each file has its own separator line', () => {
    const out = serialize([
        { path: 'a.md', content: 'aaa' },
        { path: 'b.md', content: 'bbb' },
    ]);
    assert.ok(out.includes('--- FILE: a.md\n'));
    assert.ok(out.includes('--- FILE: b.md\n'));
});

// ─── deserialize edge cases ───────────────────────────────────────────────────

test('deserialize ignores leading text before first separator', () => {
    const str = 'this is a header line\n--- FILE: x.md\ncontent';
    // The header line is before the first separator, so it should be ignored
    const result = deserialize(str);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'x.md');
    assert.equal(result[0].content, 'content');
});

test('deserialize preserves paths with slashes', () => {
    const records = [{ path: 'a/b/c/deep.md', content: 'deep content' }];
    assert.deepEqual(deserialize(serialize(records)), records);
});

test('deserialize preserves paths with special characters', () => {
    const records = [{ path: 'health/food-allergies.md', content: 'peanuts' }];
    assert.deepEqual(deserialize(serialize(records)), records);
});

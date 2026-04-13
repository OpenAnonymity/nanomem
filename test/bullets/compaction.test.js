import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactBullets } from '../../src/bullets/compaction.js';

function makeBullet(overrides = {}) {
    return {
        text: 'A fact about something',
        topic: 'general',
        tier: 'long_term',
        status: 'active',
        source: 'user_statement',
        confidence: 'high',
        updatedAt: '2024-06-01',
        expiresAt: null,
        reviewAt: null,
        explicitTier: true,
        explicitStatus: true,
        explicitSource: true,
        explicitConfidence: true,
        heading: 'General',
        section: 'long_term',
        lineIndex: 0,
        ...overrides,
    };
}

describe('compactBullets', () => {
    it('returns empty result for empty input', () => {
        const result = compactBullets([]);
        assert.deepEqual(result.working, []);
        assert.deepEqual(result.longTerm, []);
        assert.deepEqual(result.history, []);
        assert.deepEqual(result.active, []);
        assert.deepEqual(result.archive, []);
    });

    it('places an active long_term bullet into longTerm', () => {
        const result = compactBullets([makeBullet({ text: 'Loves hiking' })]);
        assert.equal(result.longTerm.length, 1);
        assert.equal(result.longTerm[0].text, 'Loves hiking');
        assert.equal(result.working.length, 0);
        assert.equal(result.history.length, 0);
    });

    it('places a working-tier bullet into working', () => {
        const result = compactBullets([makeBullet({ text: 'Debugging auth', tier: 'working', section: 'working' })]);
        assert.equal(result.working.length, 1);
        assert.equal(result.longTerm.length, 0);
    });

    it('places a superseded bullet into history', () => {
        const result = compactBullets([makeBullet({ text: 'Old fact', status: 'superseded' })]);
        assert.equal(result.history.length, 1);
        assert.equal(result.longTerm.length, 0);
    });

    it('places an expired bullet into history', () => {
        const result = compactBullets(
            [makeBullet({ text: 'Expired task', expiresAt: '2020-01-01' })],
            { today: '2024-01-01' }
        );
        assert.equal(result.history.length, 1);
        assert.equal(result.longTerm.length, 0);
    });

    it('deduplicates bullets with identical normalized text, keeping the stronger one', () => {
        const weaker = makeBullet({ text: 'Loves hiking', source: 'inference', confidence: 'low', updatedAt: '2024-01-01' });
        const stronger = makeBullet({ text: 'Loves hiking', source: 'user_statement', confidence: 'high', updatedAt: '2024-06-01' });
        const result = compactBullets([weaker, stronger]);
        assert.equal(result.longTerm.length, 1);
        assert.equal(result.longTerm[0].source, 'user_statement');
    });

    it('deduplicates regardless of input order', () => {
        const a = makeBullet({ text: 'Loves hiking', source: 'user_statement', updatedAt: '2024-06-01' });
        const b = makeBullet({ text: 'Loves hiking', source: 'inference', updatedAt: '2024-01-01' });
        const result1 = compactBullets([a, b]);
        const result2 = compactBullets([b, a]);
        assert.equal(result1.longTerm[0].source, 'user_statement');
        assert.equal(result2.longTerm[0].source, 'user_statement');
    });

    it('enforces maxActivePerTopic, overflowing extras to history', () => {
        const bullets = Array.from({ length: 5 }, (_, i) =>
            makeBullet({ text: `Fact number ${i}`, topic: 'general', updatedAt: `2024-0${i + 1}-01` })
        );
        const result = compactBullets(bullets, { maxActivePerTopic: 3 });
        assert.equal(result.longTerm.length, 3);
        assert.equal(result.history.length, 2);
    });

    it('sorts active results by recency (most recent first)', () => {
        const older = makeBullet({ text: 'Older fact', updatedAt: '2023-01-01' });
        const newer = makeBullet({ text: 'Newer fact', updatedAt: '2024-06-01' });
        const result = compactBullets([older, newer]);
        assert.equal(result.longTerm[0].text, 'Newer fact');
    });

    it('active is the union of working and longTerm', () => {
        const bullets = [
            makeBullet({ text: 'A stable fact' }),
            makeBullet({ text: 'A current task', tier: 'working', section: 'working' }),
        ];
        const result = compactBullets(bullets);
        assert.equal(result.active.length, result.working.length + result.longTerm.length);
    });

    it('archive equals history', () => {
        const result = compactBullets([makeBullet({ text: 'Old', status: 'superseded' })]);
        assert.deepEqual(result.archive, result.history);
    });

    it('skips bullets with empty text', () => {
        const result = compactBullets([makeBullet({ text: '' })]);
        assert.equal(result.longTerm.length, 0);
    });
});

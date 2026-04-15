import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreBullet, tokenizeQuery } from '../../src/internal/format/scoring.js';

describe('tokenizeQuery', () => {
    it('splits on non-alphanumeric characters', () => {
        assert.deepEqual(tokenizeQuery('foo bar baz'), ['foo', 'bar', 'baz']);
        assert.deepEqual(tokenizeQuery('hello, world!'), ['hello', 'world']);
    });
    it('filters tokens shorter than 3 characters', () => {
        const tokens = tokenizeQuery('I am a cat');
        assert.ok(!tokens.includes('i'));
        assert.ok(!tokens.includes('am'));
        assert.ok(!tokens.includes('a'));
        assert.ok(tokens.includes('cat'));
    });
    it('lowercases all tokens', () => {
        assert.deepEqual(tokenizeQuery('TypeScript Node'), ['typescript', 'node']);
    });
    it('returns empty array for empty input', () => {
        assert.deepEqual(tokenizeQuery(''), []);
        assert.deepEqual(tokenizeQuery(null), []);
    });
});

describe('scoreBullet', () => {
    const base = {
        text: 'uses typescript for all projects',
        topic: 'work',
        tier: 'long_term',
        status: 'active',
        source: 'user_statement',
        confidence: 'high',
    };

    it('returns 0 for a bullet with empty text', () => {
        assert.equal(scoreBullet({ ...base, text: '' }), 0);
    });

    it('increases score for matching query terms in text', () => {
        const withMatch = scoreBullet(base, ['typescript']);
        const noMatch = scoreBullet(base, ['python']);
        assert.ok(withMatch > noMatch);
    });

    it('increases score for matching query terms in topic', () => {
        const withTopicMatch = scoreBullet(base, ['work']);
        const noMatch = scoreBullet(base, ['hobbies']);
        assert.ok(withTopicMatch > noMatch);
    });

    it('gives higher score to working-tier bullets', () => {
        const workingScore = scoreBullet({ ...base, tier: 'working' }, []);
        const longTermScore = scoreBullet({ ...base, tier: 'long_term' }, []);
        assert.ok(workingScore > longTermScore);
    });

    it('penalizes history/superseded/expired bullets', () => {
        const activeScore = scoreBullet(base, []);
        const supersededScore = scoreBullet({ ...base, status: 'superseded' }, []);
        const historyScore = scoreBullet({ ...base, tier: 'history' }, []);
        assert.ok(activeScore > supersededScore);
        assert.ok(activeScore > historyScore);
    });

    it('gives higher score to user_statement source', () => {
        const userScore = scoreBullet({ ...base, source: 'user_statement' }, []);
        const inferenceScore = scoreBullet({ ...base, source: 'inference' }, []);
        assert.ok(userScore > inferenceScore);
    });

    it('boosts score for high confidence', () => {
        const highScore = scoreBullet({ ...base, confidence: 'high' }, []);
        const lowScore = scoreBullet({ ...base, confidence: 'low' }, []);
        assert.ok(highScore > lowScore);
    });

    it('penalizes uncertain status', () => {
        const activeScore = scoreBullet(base, []);
        const uncertainScore = scoreBullet({ ...base, status: 'uncertain' }, []);
        assert.ok(activeScore > uncertainScore);
    });

    it('returns a number for a minimal bullet', () => {
        assert.equal(typeof scoreBullet({ text: 'hello world' }), 'number');
    });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    safeDateIso,
    normalizeTopic,
    normalizeTier,
    normalizeStatus,
    normalizeSource,
    normalizeConfidence,
    defaultConfidenceForSource,
    inferTierFromSection,
    inferStatusFromSection,
    normalizeTierToSection,
    inferTierFromBullet,
    isExpiredBullet,
    ensureBulletMetadata,
} from '../../src/bullets/normalize.js';

describe('safeDateIso', () => {
    it('formats a valid date string to YYYY-MM-DD', () => {
        assert.equal(safeDateIso('2024-06-15'), '2024-06-15');
    });
    it('returns null for null/undefined', () => {
        assert.equal(safeDateIso(null), null);
        assert.equal(safeDateIso(undefined), null);
    });
    it('returns null for invalid dates', () => {
        assert.equal(safeDateIso('not-a-date'), null);
    });
    it('accepts a numeric timestamp', () => {
        const result = safeDateIso(new Date('2024-01-01').getTime());
        assert.equal(result, '2024-01-01');
    });
});

describe('normalizeTopic', () => {
    it('lowercases and trims', () => {
        assert.equal(normalizeTopic('  Hello World  '), 'hello-world');
    });
    it('replaces special chars with hyphens', () => {
        assert.equal(normalizeTopic('foo!bar'), 'foo-bar');
    });
    it('collapses multiple hyphens', () => {
        assert.equal(normalizeTopic('a--b'), 'a-b');
    });
    it('strips leading and trailing hyphens/slashes', () => {
        assert.equal(normalizeTopic('-/foo/-'), 'foo');
    });
    it('returns fallback for empty input', () => {
        assert.equal(normalizeTopic(''), 'general');
        assert.equal(normalizeTopic(null), 'general');
    });
    it('preserves allowed separators', () => {
        assert.equal(normalizeTopic('work/project'), 'work/project');
    });
});

describe('normalizeTier', () => {
    it('maps working variants', () => {
        assert.equal(normalizeTier('working'), 'working');
        assert.equal(normalizeTier('short_term'), 'working');
        assert.equal(normalizeTier('short-term'), 'working');
    });
    it('maps long-term variants', () => {
        assert.equal(normalizeTier('long_term'), 'long_term');
        assert.equal(normalizeTier('long-term'), 'long_term');
        assert.equal(normalizeTier('longterm'), 'long_term');
        assert.equal(normalizeTier('active'), 'long_term');
    });
    it('maps history variants', () => {
        assert.equal(normalizeTier('history'), 'history');
        assert.equal(normalizeTier('archive'), 'history');
        assert.equal(normalizeTier('archived'), 'history');
    });
    it('returns fallback for unknown value', () => {
        assert.equal(normalizeTier('unknown'), 'long_term');
        assert.equal(normalizeTier('unknown', 'working'), 'working');
    });
});

describe('normalizeStatus', () => {
    it('maps active variants', () => {
        assert.equal(normalizeStatus('active'), 'active');
        assert.equal(normalizeStatus('current'), 'active');
    });
    it('maps superseded variants', () => {
        assert.equal(normalizeStatus('superseded'), 'superseded');
        assert.equal(normalizeStatus('replaced'), 'superseded');
        assert.equal(normalizeStatus('resolved'), 'superseded');
    });
    it('maps expired variants', () => {
        assert.equal(normalizeStatus('expired'), 'expired');
        assert.equal(normalizeStatus('stale'), 'expired');
    });
    it('maps uncertain variants', () => {
        assert.equal(normalizeStatus('uncertain'), 'uncertain');
        assert.equal(normalizeStatus('tentative'), 'uncertain');
    });
    it('returns fallback for unknown', () => {
        assert.equal(normalizeStatus(''), 'active');
    });
});

describe('normalizeSource', () => {
    it('maps user variants', () => {
        assert.equal(normalizeSource('user_statement'), 'user_statement');
        assert.equal(normalizeSource('user'), 'user_statement');
        assert.equal(normalizeSource('explicit_user'), 'user_statement');
    });
    it('maps assistant variants', () => {
        assert.equal(normalizeSource('assistant_summary'), 'assistant_summary');
        assert.equal(normalizeSource('assistant'), 'assistant_summary');
        assert.equal(normalizeSource('summary'), 'assistant_summary');
    });
    it('maps inference variants', () => {
        assert.equal(normalizeSource('inference'), 'inference');
        assert.equal(normalizeSource('inferred'), 'inference');
    });
    it('maps system variants', () => {
        assert.equal(normalizeSource('system'), 'system');
        assert.equal(normalizeSource('system_note'), 'system');
    });
    it('returns fallback for unknown', () => {
        assert.equal(normalizeSource(''), 'user_statement');
    });
});

describe('normalizeConfidence', () => {
    it('maps high variants', () => {
        assert.equal(normalizeConfidence('high'), 'high');
        assert.equal(normalizeConfidence('strong'), 'high');
    });
    it('maps medium variants', () => {
        assert.equal(normalizeConfidence('medium'), 'medium');
        assert.equal(normalizeConfidence('med'), 'medium');
        assert.equal(normalizeConfidence('moderate'), 'medium');
    });
    it('maps low variants', () => {
        assert.equal(normalizeConfidence('low'), 'low');
        assert.equal(normalizeConfidence('weak'), 'low');
    });
    it('returns fallback for unknown', () => {
        assert.equal(normalizeConfidence(''), 'medium');
    });
});

describe('defaultConfidenceForSource', () => {
    it('returns high for user_statement', () => {
        assert.equal(defaultConfidenceForSource('user_statement'), 'high');
    });
    it('returns medium for assistant_summary and system', () => {
        assert.equal(defaultConfidenceForSource('assistant_summary'), 'medium');
        assert.equal(defaultConfidenceForSource('system'), 'medium');
    });
    it('returns low for inference and unknown', () => {
        assert.equal(defaultConfidenceForSource('inference'), 'low');
        assert.equal(defaultConfidenceForSource('unknown'), 'low');
    });
});

describe('inferTierFromSection', () => {
    it('returns working for working section', () => {
        assert.equal(inferTierFromSection('working'), 'working');
    });
    it('returns history for history section', () => {
        assert.equal(inferTierFromSection('history'), 'history');
    });
    it('returns long_term for anything else', () => {
        assert.equal(inferTierFromSection('long_term'), 'long_term');
        assert.equal(inferTierFromSection('other'), 'long_term');
    });
});

describe('inferStatusFromSection', () => {
    it('returns superseded for history', () => {
        assert.equal(inferStatusFromSection('history'), 'superseded');
    });
    it('returns active for all other sections', () => {
        assert.equal(inferStatusFromSection('working'), 'active');
        assert.equal(inferStatusFromSection('long_term'), 'active');
    });
});

describe('normalizeTierToSection', () => {
    it('maps working tier to working section', () => {
        assert.equal(normalizeTierToSection('working'), 'working');
        assert.equal(normalizeTierToSection('short_term'), 'working');
    });
    it('maps history tier to history section', () => {
        assert.equal(normalizeTierToSection('history'), 'history');
        assert.equal(normalizeTierToSection('archive'), 'history');
    });
    it('maps long_term tier to long_term section', () => {
        assert.equal(normalizeTierToSection('long_term'), 'long_term');
        assert.equal(normalizeTierToSection('active'), 'long_term');
    });
});

describe('inferTierFromBullet', () => {
    it('returns working for bullets with reviewAt', () => {
        assert.equal(inferTierFromBullet({ text: 'something', reviewAt: '2024-06-01' }), 'working');
    });
    it('returns working for bullets with expiresAt', () => {
        assert.equal(inferTierFromBullet({ text: 'something', expiresAt: '2024-06-01' }), 'working');
    });
    it('detects working-tier keywords in text', () => {
        assert.equal(inferTierFromBullet({ text: 'currently working on a project' }), 'working');
        assert.equal(inferTierFromBullet({ text: 'planning a trip next month' }), 'working');
        assert.equal(inferTierFromBullet({ text: 'this week I am debugging the auth module' }), 'working');
    });
    it('returns long_term for stable facts', () => {
        assert.equal(inferTierFromBullet({ text: 'lives in New York' }), 'long_term');
    });
    it('returns fallback for empty text', () => {
        assert.equal(inferTierFromBullet({ text: '' }, 'history'), 'history');
    });
});

describe('isExpiredBullet', () => {
    it('returns false if no expiresAt', () => {
        assert.equal(isExpiredBullet({ expiresAt: null }), false);
    });
    it('returns true if expiresAt is before today', () => {
        assert.equal(isExpiredBullet({ expiresAt: '2000-01-01' }, '2024-01-01'), true);
    });
    it('returns false if expiresAt is today', () => {
        assert.equal(isExpiredBullet({ expiresAt: '2024-01-01' }, '2024-01-01'), false);
    });
    it('returns false if expiresAt is in the future', () => {
        assert.equal(isExpiredBullet({ expiresAt: '2030-01-01' }, '2024-01-01'), false);
    });
});

describe('ensureBulletMetadata', () => {
    it('fills in defaults for a minimal bullet', () => {
        const result = ensureBulletMetadata({ text: 'Loves hiking' });
        assert.equal(result.text, 'Loves hiking');
        assert.equal(result.topic, 'general');
        assert.equal(result.tier, 'long_term');
        assert.equal(result.status, 'active');
        assert.equal(result.source, 'user_statement');
        assert.equal(result.confidence, 'high');
        assert.equal(result.heading, 'General');
    });
    it('respects explicit values', () => {
        const result = ensureBulletMetadata({
            text: 'Debugging auth',
            tier: 'working',
            status: 'uncertain',
            source: 'inference',
            confidence: 'low',
            explicitTier: true,
            explicitStatus: true,
            explicitSource: true,
            explicitConfidence: true,
        });
        assert.equal(result.tier, 'working');
        assert.equal(result.status, 'uncertain');
        assert.equal(result.source, 'inference');
        assert.equal(result.confidence, 'low');
    });
    it('applies option overrides', () => {
        const result = ensureBulletMetadata(
            { text: 'Some fact' },
            { defaultTopic: 'health', defaultSource: 'assistant_summary', updatedAt: '2024-03-01' }
        );
        assert.equal(result.topic, 'health');
        assert.equal(result.source, 'assistant_summary');
        assert.equal(result.updatedAt, '2024-03-01');
    });
    it('infers working tier from text keywords', () => {
        const result = ensureBulletMetadata({ text: 'currently evaluating new frameworks' });
        assert.equal(result.tier, 'working');
        assert.equal(result.section, 'working');
    });
});

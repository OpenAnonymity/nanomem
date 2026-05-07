import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBullets, countBullets, extractTitles, renderBullet, renderCompactedDocument } from '../../src/internal/format/parser.js';

const SAMPLE_DOC = `
# Memory: Work

## Working memory (current context subject to change)
- Debugging the auth module | topic=work | tier=working | status=active | source=user_statement | confidence=high | updated_at=2024-06-01

## Long-term memory (stable facts that are unlikely to change)
- Uses TypeScript for all new projects | topic=work | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2024-01-10
- Prefers functional programming style | topic=work | tier=long_term | status=active | source=assistant_summary | confidence=medium | updated_at=2024-02-01

## History (no longer current)
- Was using Flow for type checking | topic=work | tier=history | status=superseded | source=user_statement | confidence=high | updated_at=2023-05-01
`.trim();

describe('parseBullets', () => {
    it('returns an empty array for empty input', () => {
        assert.deepEqual(parseBullets(''), []);
        assert.deepEqual(parseBullets(null), []);
    });

    it('parses bullets from a well-formed document', () => {
        const bullets = parseBullets(SAMPLE_DOC);
        assert.equal(bullets.length, 4);
    });

    it('parses text correctly', () => {
        const bullets = parseBullets(SAMPLE_DOC);
        assert.equal(bullets[0].text, 'Debugging the auth module');
        assert.equal(bullets[1].text, 'Uses TypeScript for all new projects');
    });

    it('parses metadata fields', () => {
        const bullets = parseBullets(SAMPLE_DOC);
        const b = bullets[0];
        assert.equal(b.topic, 'work');
        assert.equal(b.tier, 'working');
        assert.equal(b.status, 'active');
        assert.equal(b.source, 'user_statement');
        assert.equal(b.confidence, 1.0);
        assert.equal(b.updatedAt, '2024-06-01T00:00');
    });

    it('assigns section from heading context', () => {
        const bullets = parseBullets(SAMPLE_DOC);
        assert.equal(bullets[0].section, 'working');
        assert.equal(bullets[1].section, 'long_term');
        assert.equal(bullets[3].section, 'history');
    });

    it('records lineIndex', () => {
        const bullets = parseBullets(SAMPLE_DOC);
        assert.ok(typeof bullets[0].lineIndex === 'number');
    });

    it('infers tier from section when not explicit', () => {
        const doc = `## Working memory (current context subject to change)\n- A task I am working on`;
        const bullets = parseBullets(doc);
        assert.equal(bullets[0].tier, 'working');
        assert.equal(bullets[0].explicitTier, false);
    });

    it('ignores lines that are not bullets or headings', () => {
        const doc = `Some prose here.\n- actual bullet\nMore prose.`;
        const bullets = parseBullets(doc);
        assert.equal(bullets.length, 1);
        assert.equal(bullets[0].text, 'actual bullet');
    });

    it('handles bullets with no metadata', () => {
        const bullets = parseBullets('- Plain bullet text');
        assert.equal(bullets.length, 1);
        assert.equal(bullets[0].text, 'Plain bullet text');
    });
});

describe('countBullets', () => {
    it('counts bullets in the document', () => {
        assert.equal(countBullets(SAMPLE_DOC), 4);
    });
    it('returns 0 for empty input', () => {
        assert.equal(countBullets(''), 0);
    });
});

describe('extractTitles', () => {
    it('extracts non-structural headings', () => {
        const titles = extractTitles(SAMPLE_DOC);
        assert.ok(titles.includes('Memory: Work'));
    });
    it('excludes structural headings like Working, Long-Term, History', () => {
        const titles = extractTitles(SAMPLE_DOC);
        assert.ok(!titles.includes('Working memory (current context subject to change)'));
        assert.ok(!titles.includes('Long-term memory (stable facts that are unlikely to change)'));
        assert.ok(!titles.includes('History (no longer current)'));
    });
    it('returns empty array for no headings', () => {
        assert.deepEqual(extractTitles('- just a bullet'), []);
    });
});

describe('renderBullet', () => {
    it('renders a bullet with all required fields', () => {
        const bullet = {
            text: 'Loves hiking',
            topic: 'hobbies',
            tier: 'long_term',
            status: 'active',
            source: 'user_statement',
            confidence: 1.0,
            updatedAt: '2024-06-01',
        };
        const rendered = renderBullet(bullet);
        assert.ok(rendered.startsWith('- Loves hiking |'));
        assert.ok(rendered.includes('topic=hobbies'));
        assert.ok(rendered.includes('tier=long_term'));
        assert.ok(rendered.includes('status=active'));
        assert.ok(rendered.includes('source=user_statement'));
        assert.ok(rendered.includes('confidence=1'));
        assert.ok(rendered.includes('updated_at=2024-06-01'));
    });

    it('omits review_at and expires_at when not set', () => {
        const rendered = renderBullet({ text: 'A fact', updatedAt: '2024-01-01' });
        assert.ok(!rendered.includes('review_at'));
        assert.ok(!rendered.includes('expires_at'));
    });

    it('includes review_at when set', () => {
        const rendered = renderBullet({ text: 'A task', reviewAt: '2024-07-01', updatedAt: '2024-01-01' });
        assert.ok(rendered.includes('review_at=2024-07-01'));
    });

    it('includes expires_at when set', () => {
        const rendered = renderBullet({ text: 'A task', expiresAt: '2024-09-01', updatedAt: '2024-01-01' });
        assert.ok(rendered.includes('expires_at=2024-09-01'));
    });
});

describe('renderBullet / parseBullets round-trip', () => {
    it('parses back what was rendered', () => {
        const original = {
            text: 'Prefers dark mode',
            topic: 'preferences',
            tier: 'long_term',
            status: 'active',
            source: 'user_statement',
            confidence: 1.0,
            updatedAt: '2024-06-15',
            explicitTier: true,
            explicitStatus: true,
            explicitSource: true,
            explicitConfidence: true,
        };
        const rendered = renderBullet(original);
        const parsed = parseBullets(rendered);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].text, original.text);
        assert.equal(parsed[0].topic, original.topic);
        assert.equal(parsed[0].tier, original.tier);
        assert.equal(parsed[0].status, original.status);
        assert.equal(parsed[0].source, original.source);
        assert.equal(parsed[0].confidence, original.confidence);
        assert.equal(parsed[0].updatedAt, '2024-06-15T00:00');
    });

    it('preserves a fractional confidence value', () => {
        const original = {
            text: 'Sometimes drinks tea',
            topic: 'habits',
            tier: 'long_term',
            status: 'active',
            source: 'user_statement',
            confidence: 0.65,
            updatedAt: '2024-06-15',
            explicitConfidence: true,
        };
        const rendered = renderBullet(original);
        const parsed = parseBullets(rendered);
        assert.equal(parsed[0].confidence, 0.65);
    });
});

describe('renderCompactedDocument', () => {
    const working = [{ text: 'A working item', topic: 'work', tier: 'working', status: 'active', source: 'user_statement', confidence: 'high', updatedAt: '2024-06-01', explicitTier: true, explicitStatus: true, explicitSource: true, explicitConfidence: true }];
    const longTerm = [{ text: 'A stable fact', topic: 'work', tier: 'long_term', status: 'active', source: 'user_statement', confidence: 'high', updatedAt: '2024-01-01', explicitTier: true, explicitStatus: true, explicitSource: true, explicitConfidence: true }];
    const history = [{ text: 'An old fact', topic: 'work', tier: 'history', status: 'superseded', source: 'user_statement', confidence: 'high', updatedAt: '2023-01-01', explicitTier: true, explicitStatus: true, explicitSource: true, explicitConfidence: true }];

    it('produces a document with all three sections', () => {
        const doc = renderCompactedDocument(working, longTerm, history);
        assert.ok(doc.includes('## Working memory (current context subject to change)'));
        assert.ok(doc.includes('## Long-term memory (stable facts that are unlikely to change)'));
        assert.ok(doc.includes('## History (no longer current)'));
    });

    it('uses titleTopic option for the document heading', () => {
        const doc = renderCompactedDocument(working, longTerm, history, { titleTopic: 'my-project' });
        assert.ok(doc.includes('# Memory: My Project'));
    });

    it('shows _No entries yet._ for empty sections', () => {
        const doc = renderCompactedDocument([], [], []);
        assert.ok(doc.includes('_No entries yet._'));
    });

    it('forces history tier on items in the History section', () => {
        const doc = renderCompactedDocument([], [], history);
        assert.ok(doc.includes('tier=history'));
    });
});

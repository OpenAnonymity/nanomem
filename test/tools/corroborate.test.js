import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createExtractionExecutors } from '../../src/tools/executors.js';

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

describe('corroborate_bullet executor', () => {
    let backend;
    let executors;

    beforeEach(() => {
        backend = makeBackend();
        executors = createExtractionExecutors(backend, { updatedAt: '2026-05-07T12:00' });
    });

    it('bumps confidence on an active bullet and refreshes updated_at', async () => {
        const path = 'health/asthma.md';
        const initial = `# Memory: Asthma

## Long-term memory (stable facts that are unlikely to change)
- Has asthma | topic=health | tier=long_term | status=active | source=user_statement | confidence=0.6 | updated_at=2026-01-15T08:00
`;
        await backend.write(path, initial);

        const raw = await executors.corroborate_bullet({ path, fact_text: 'Has asthma' });
        const result = JSON.parse(raw);

        assert.equal(result.success, true);
        assert.equal(result.action, 'corroborated');
        assert.equal(result.confidence_before, 0.6);
        assert.ok(Math.abs(result.confidence_after - 0.68) < 1e-9);

        const after = await backend.read(path);
        assert.match(after, /confidence=0.68/);
        assert.match(after, /updated_at=2026-05-07T12:00/);
        // Bullet should be in the Long-term section, with History empty
        const longTermSection = after.split('## History')[0];
        assert.match(longTermSection, /Has asthma/);
        const historySection = after.split('## History')[1] || '';
        assert.match(historySection, /_No entries yet\._/);
    });

    it('returns an error for a non-existent file', async () => {
        const raw = await executors.corroborate_bullet({ path: 'missing.md', fact_text: 'whatever' });
        const result = JSON.parse(raw);
        assert.equal(result.error, 'File not found: missing.md');
    });

    it('returns an error when no bullet matches the fact_text', async () => {
        const path = 'health/asthma.md';
        await backend.write(path, `# Memory: Asthma

## Long-term memory (stable facts that are unlikely to change)
- Has asthma | topic=health | tier=long_term | status=active | source=user_statement | confidence=0.8 | updated_at=2026-01-15T08:00
`);

        const raw = await executors.corroborate_bullet({ path, fact_text: 'Likes hiking' });
        const result = JSON.parse(raw);
        assert.match(result.error, /No matching bullet/);
    });

    it('revives a history-tier bullet back to active long_term', async () => {
        const path = 'side-project/mise.md';
        const initial = `# Memory: Mise

## Long-term memory (stable facts that are unlikely to change)
_No entries yet._

## History (no longer current)
- Mise crossed 200 users this week | topic=mise | tier=history | status=superseded | source=user_statement | confidence=0.45 | updated_at=2026-04-30T12:00
`;
        await backend.write(path, initial);

        const raw = await executors.corroborate_bullet({ path, fact_text: 'Mise crossed 200 users this week' });
        const result = JSON.parse(raw);

        assert.equal(result.success, true);
        assert.equal(result.action, 'revived');
        assert.equal(result.confidence_before, 0.45);
        assert.ok(Math.abs(result.confidence_after - 0.56) < 1e-9);

        const after = await backend.read(path);
        // Bullet should now appear in Long-term, not History
        const longTermSection = after.split('## History')[0];
        assert.match(longTermSection, /Mise crossed 200 users this week/);
        assert.match(longTermSection, /tier=long_term/);
        assert.match(longTermSection, /status=active/);
        assert.match(after, /confidence=0.56/);
    });

    it('accepts pipe-delimited input by stripping metadata', async () => {
        const path = 'work/role.md';
        await backend.write(path, `# Memory: Role

## Long-term memory (stable facts that are unlikely to change)
- Works at Stripe | topic=work | tier=long_term | status=active | source=user_statement | confidence=0.8 | updated_at=2026-01-15T08:00
`);

        const raw = await executors.corroborate_bullet({
            path,
            fact_text: 'Works at Stripe | topic=work | tier=long_term | status=active | source=user_statement | confidence=0.8 | updated_at=2026-01-15T08:00',
        });
        const result = JSON.parse(raw);
        assert.equal(result.success, true);
        assert.equal(result.action, 'corroborated');
        assert.ok(Math.abs(result.confidence_after - 0.84) < 1e-9);
    });
});

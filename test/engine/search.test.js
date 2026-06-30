import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStorage } from '../../src/internal/storage/ram.js';

async function storageWith(files) {
    const backend = new InMemoryStorage();
    await backend.init();
    for (const [path, content] of Object.entries(files)) {
        await backend.write(path, content);
    }
    return backend;
}

describe('BaseStorage.search (BM25 + substring recall)', () => {
    it('ranks token matches by relevance', async () => {
        const backend = await storageWith({
            'work/nomnom.md': '# NomNom\n- NomNom ships June 15. The deadline is firm.',
            'work/mise.md': '# Mise\n- Mise is in early alpha.',
            'health/yoga.md': '# Yoga\n- Practices yoga every morning.',
        });

        const paths = (await backend.search('deadline')).map((r) => r.path);

        assert.ok(paths.includes('work/nomnom.md'));
        assert.ok(!paths.includes('health/yoga.md'));
    });

    it('still returns substring-only matches when another doc has the bare token', async () => {
        // Regression: "cook" tokenizes to ["cook"], which matches the bare token in
        // misc.md but NOT the token "cooking". The substring-only "cooking" file must
        // not be dropped just because misc.md produced a BM25 hit.
        const backend = await storageWith({
            'hobbies/cooking.md': '# Cooking\n- Enjoys cooking Italian food on weekends.',
            'notes/misc.md': '# Misc\n- Remember to cook dinner tonight.',
        });

        const paths = (await backend.search('cook')).map((r) => r.path);

        assert.ok(paths.includes('notes/misc.md'), 'token match should be present');
        assert.ok(paths.includes('hobbies/cooking.md'), 'substring-only match must not be dropped');
    });

    it('falls back to substring matching for sub-3-char queries that tokenize to nothing', async () => {
        const backend = await storageWith({
            'lang/go.md': '# Go\n- Learning Go for backend services.',
            'health/yoga.md': '# Yoga\n- Practices yoga every morning.',
        });

        const paths = (await backend.search('Go')).map((r) => r.path);

        assert.deepEqual(paths, ['lang/go.md']);
    });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRetriever } from '../../src/tools/retrieval.js';

function createRetriever({ searchResults = [] } = {}) {
    const backend = {
        async init() {},
        async getTree() {
            return 'work/projects.md';
        },
        async exportAll() {
            return [{ path: 'work/projects.md', itemCount: 1 }];
        },
        async search() {
            return searchResults;
        },
        async read() {
            return null;
        }
    };

    const bulletIndex = {
        async init() {},
        getBulletsForPaths() {
            return [];
        },
        async refreshPath() {}
    };

    const llmClient = {
        async createChatCompletion() {
            throw new Error('simulated adaptive failure');
        }
    };

    return new MemoryRetriever({
        backend,
        bulletIndex,
        llmClient,
        model: 'test-model'
    });
}

describe('retrieveAdaptively', () => {
    it('returns a skipped result instead of null when adaptive retrieval fallback finds nothing', async () => {
        const retriever = createRetriever();

        const result = await retriever.retrieveAdaptively(
            'what deadlines do those projects have?',
            '**NomNom** has a June 15 launch deadline. **Mise** is in early alpha.',
            null
        );

        assert.deepEqual(result, {
            files: [],
            paths: [],
            assembledContext: null,
            skipped: true,
            skipReason: 'No new relevant memory found.'
        });
    });

    it('expands referential fallback queries with salient entities from prior retrieved context', () => {
        const retriever = createRetriever();

        const query = retriever._buildAdaptiveFallbackQuery(
            'what deadlines do those projects have?',
            'You have two projects: **NomNom** and **Mise**.'
        );

        assert.match(query, /\bNomNom\b/);
        assert.match(query, /\bMise\b/);
    });
});

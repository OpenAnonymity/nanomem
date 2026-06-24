/**
 * Okapi BM25 ranking over a document corpus.
 *
 * Storage search uses this to rank documents by relevance instead of returning
 * substring matches in arbitrary order. The IDF term naturally down-weights
 * words that are common across the corpus, so callers can fold noisy context
 * (e.g. recent conversation) into a query without a hand-maintained stopword
 * list — the filler self-attenuates.
 */
import { tokenizeQuery } from './scoring.js';

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/**
 * Rank documents against a query with Okapi BM25 (Lucene-style non-negative IDF).
 *
 * @param {string} query
 * @param {{ path: string, content: string }[]} documents
 * @param {{ k1?: number, b?: number }} [opts]
 * @returns {{ path: string, score: number }[]} matches (score > 0), highest first
 */
export function rankBM25(query, documents, { k1 = DEFAULT_K1, b = DEFAULT_B } = {}) {
    const queryTerms = [...new Set(tokenizeQuery(query))];
    if (queryTerms.length === 0 || documents.length === 0) return [];

    const docs = documents.map((doc) => {
        const tf = new Map();
        let length = 0;
        for (const token of tokenizeQuery(doc.content || '')) {
            tf.set(token, (tf.get(token) || 0) + 1);
            length += 1;
        }
        return { path: doc.path, tf, length };
    });

    const N = docs.length;
    const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / N || 1;

    const idf = new Map();
    for (const term of queryTerms) {
        let df = 0;
        for (const d of docs) if (d.tf.has(term)) df += 1;
        // Lucene-style smoothing keeps IDF positive even for terms in every doc.
        idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }

    const ranked = [];
    for (const d of docs) {
        let score = 0;
        for (const term of queryTerms) {
            const f = d.tf.get(term);
            if (!f) continue;
            const denom = f + k1 * (1 - b + (b * d.length) / avgdl);
            score += idf.get(term) * ((f * (k1 + 1)) / denom);
        }
        if (score > 0) ranked.push({ path: d.path, score });
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked;
}

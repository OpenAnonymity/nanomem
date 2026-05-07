/**
 * Relevance scoring for memory bullet retrieval.
 */
/** @import { Bullet } from '../../types.js' */
import {
    normalizeTier,
    normalizeStatus,
    normalizeSource,
    normalizeTierToSection,
    inferStatusFromSection,
} from './normalize.js';

/**
 * @param {Partial<Bullet>} bullet
 * @param {string[]} [queryTerms]
 * @returns {number}
 */
export function scoreBullet(bullet, queryTerms = []) {
    const text = String(bullet?.text || '').toLowerCase();
    const topic = String(bullet?.topic || '').toLowerCase();
    const tier = normalizeTier(bullet?.tier || bullet?.section || 'long_term');
    const status = normalizeStatus(bullet?.status || inferStatusFromSection(normalizeTierToSection(tier)));
    if (!text) return 0;

    let score = 0;
    for (const term of queryTerms) {
        if (!term) continue;
        if (text.includes(term)) score += 2;
        if (topic.includes(term)) score += 1;
    }
    if (tier === 'working') score += 2;
    if (tier === 'long_term') score += 1;
    if (status === 'active') score += 2;
    if (status === 'uncertain') score -= 1;
    if (status === 'expired' || status === 'superseded' || tier === 'history') score -= 3;
    if (bullet?.source === 'user_statement') score += 2;
    if (bullet?.source === 'inference') score -= 1;
    if (typeof bullet?.confidence === 'number' && bullet.confidence >= 0.8) score += 2;
    if (typeof bullet?.confidence === 'number' && bullet.confidence <= 0.3) score -= 2;
    return score;
}

/**
 * @param {string} query
 * @returns {string[]}
 */
export function tokenizeQuery(query) {
    return String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3);
}

/**
 * Bullet compaction — deduplication, tier assignment, strength-based ordering.
 *
 * Strength ordering uses source > confidence > recency:
 *   user_statement > assistant_summary > system > inference
 *   high > medium > low
 *   newer > older
 */
/** @import { Bullet, CompactionResult, CompactBulletsOptions, Confidence, Source } from '../types.js' */
import {
    ensureBulletMetadata,
    normalizeFactText,
    normalizeTier,
    normalizeStatus,
    normalizeSource,
    normalizeConfidence,
    normalizeTierToSection,
    inferStatusFromSection,
    isExpiredBullet,
    todayIsoDate,
    normalizeTopic,
    defaultConfidenceForSource,
} from './normalize.js';

/**
 * Compact a list of bullets: deduplicate, assign tiers, enforce limits.
 * @param {Bullet[]} bullets
 * @param {CompactBulletsOptions} [options]
 * @returns {CompactionResult}
 */
export function compactBullets(bullets, options = {}) {
    const today = options.today || todayIsoDate();
    const maxActivePerTopic = typeof options.maxActivePerTopic === 'number' && Number.isFinite(options.maxActivePerTopic)
        ? Math.max(1, options.maxActivePerTopic)
        : 24;
    const defaultTopic = normalizeTopic(options.defaultTopic || 'general');

    // Deduplicate by normalized text — keep the stronger/newer variant.
    const dedup = new Map();
    for (const original of bullets) {
        const normalized = ensureBulletMetadata(original, { defaultTopic, updatedAt: today });
        const key = normalizeFactText(normalized.text);
        if (!key) continue;
        const existing = dedup.get(key);
        if (!existing || compareBulletStrength(normalized, existing) >= 0) {
            dedup.set(key, normalized);
        }
    }

    const working = [];
    const longTerm = [];
    const history = [];

    // Group by topic, separate expired/superseded upfront.
    const byTopic = new Map();
    for (const bullet of dedup.values()) {
        const tier = normalizeTier(bullet.tier || bullet.section || 'long_term');
        const status = normalizeStatus(bullet.status || inferStatusFromSection(normalizeTierToSection(tier)));

        if (tier === 'history' || status === 'superseded' || status === 'expired' || isExpiredBullet(bullet, today)) {
            history.push({ ...bullet, tier: 'history', status: status === 'active' ? 'superseded' : status, section: 'history' });
            continue;
        }

        const topic = bullet.topic || defaultTopic;
        const list = byTopic.get(topic) || [];
        list.push({ ...bullet, topic, tier, status, section: normalizeTierToSection(tier) });
        byTopic.set(topic, list);
    }

    // Sort by strength, enforce per-topic limit, overflow to history.
    for (const [topic, list] of byTopic.entries()) {
        list.sort((a, b) => compareBulletStrength(b, a));
        for (const item of list.slice(0, maxActivePerTopic)) {
            if (item.tier === 'working') {
                working.push({ ...item, topic, tier: 'working', status: item.status || 'active', section: 'working' });
            } else {
                longTerm.push({ ...item, topic, tier: 'long_term', status: item.status || 'active', section: 'long_term' });
            }
        }
        for (const item of list.slice(maxActivePerTopic)) {
            history.push({ ...item, topic, tier: 'history', status: 'superseded', section: 'history' });
        }
    }

    const byRecency = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '');
    working.sort(byRecency);
    longTerm.sort(byRecency);
    history.sort(byRecency);

    return { working, longTerm, history, active: [...working, ...longTerm], archive: history };
}

function compareBulletStrength(a, b) {
    const aSource = normalizeSource(a?.source, 'user_statement');
    const bSource = normalizeSource(b?.source, 'user_statement');
    const aConf = normalizeConfidence(a?.confidence, defaultConfidenceForSource(aSource));
    const bConf = normalizeConfidence(b?.confidence, defaultConfidenceForSource(bSource));

    const srcRank = { inference: 0, system: 1, assistant_summary: 2, user_statement: 3 };
    const srcDiff = (srcRank[aSource] ?? 0) - (srcRank[bSource] ?? 0);
    if (srcDiff !== 0) return srcDiff;

    const confRank = { low: 0, medium: 1, high: 2 };
    const confDiff = (confRank[aConf] ?? 1) - (confRank[bConf] ?? 1);
    if (confDiff !== 0) return confDiff;

    return String(a?.updatedAt || '').localeCompare(String(b?.updatedAt || ''));
}

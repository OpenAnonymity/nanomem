/**
 * Normalization utilities for memory bullet metadata.
 * @import { Tier, Status, Source, Confidence, Bullet, EnsureBulletMetadataOptions } from '../../types.js'
 */

/**
 * @param {string | number | null | undefined} value
 * @returns {string | null}
 */
export function safeDateIso(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

/** @returns {string} */
export function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
}

/** @returns {string} YYYY-MM-DDTHH:MM in local time */
export function nowIsoDateTime() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {string | number | null | undefined} value
 * @returns {string | null} YYYY-MM-DDTHH:MM in local time or null
 */
export function safeDateTimeIso(value) {
    if (!value) return null;
    // Date-only strings (YYYY-MM-DD) are parsed as UTC midnight by JS — append time to force local interpretation.
    const input = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? `${value}T00:00:00`
        : value;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {string} path
 * @returns {string}
 */
export function inferTopicFromPath(path) {
    if (!path || typeof path !== 'string') return 'general';
    const first = path.split('/')[0]?.trim().toLowerCase();
    return first || 'general';
}

/**
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeTopic(value, fallback = 'general') {
    const source = String(value || '').trim().toLowerCase();
    const normalized = source
        .replace(/[^a-z0-9/_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-/]+|[-/]+$/g, '');
    return normalized || fallback;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeFactText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {string | null | undefined} value
 * @param {Tier} [fallback]
 * @returns {Tier}
 */
export function normalizeTier(value, fallback = 'long_term') {
    const source = String(value || '').trim().toLowerCase();
    if (['working', 'short_term', 'short-term'].includes(source)) return 'working';
    if (['long_term', 'long-term', 'longterm', 'active'].includes(source)) return 'long_term';
    if (['history', 'archive', 'archived'].includes(source)) return 'history';
    return fallback;
}

/**
 * @param {string | null | undefined} value
 * @param {Status} [fallback]
 * @returns {Status}
 */
export function normalizeStatus(value, fallback = 'active') {
    const source = String(value || '').trim().toLowerCase();
    if (['active', 'current'].includes(source)) return 'active';
    if (['superseded', 'replaced', 'resolved'].includes(source)) return 'superseded';
    if (['expired', 'stale'].includes(source)) return 'expired';
    if (['uncertain', 'tentative'].includes(source)) return 'uncertain';
    return fallback;
}

/**
 * @param {string | null | undefined} value
 * @param {Source} [fallback]
 * @returns {Source}
 */
export function normalizeSource(value, fallback = 'user_statement') {
    const source = String(value || '').trim().toLowerCase();
    if (['user_statement', 'user', 'explicit_user'].includes(source)) return 'user_statement';
    if (['assistant_summary', 'assistant', 'summary'].includes(source)) return 'assistant_summary';
    if (['inference', 'inferred'].includes(source)) return 'inference';
    if (['system', 'system_note'].includes(source)) return 'system';
    return fallback;
}

/**
 * @param {number | string | null | undefined} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeConfidence(value, fallback = 0.7) {
    if (typeof value === 'number') return Math.min(1, Math.max(0, value));
    const source = String(value || '').trim().toLowerCase();
    if (['high', 'strong'].includes(source)) return 1.0;
    if (['medium', 'med', 'moderate'].includes(source)) return 0.7;
    if (['low', 'weak'].includes(source)) return 0.3;
    const parsed = parseFloat(source);
    if (!isNaN(parsed)) return Math.min(1, Math.max(0, parsed));
    return typeof fallback === 'number' ? fallback : 0.7;
}

/**
 * @param {Source | string | null | undefined} source
 * @returns {number}
 */
export function defaultConfidenceForSource(source) {
    if (source === 'user_statement') return 1.0;
    if (source === 'assistant_summary') return 0.7;
    if (source === 'system') return 0.7;
    return 0.3;
}

export const CONTRADICTION_DECAY_FACTOR = 0.5;

/**
 * Reduce a bullet's confidence after it has been contradicted via
 * update_bullets. Multiplies by CONTRADICTION_DECAY_FACTOR and clamps to [0, 1].
 *
 * @param {number | string | null | undefined} value
 * @returns {number}
 */
export function bumpDownConfidence(value) {
    const current = normalizeConfidence(value);
    return Math.min(1, Math.max(0, current * CONTRADICTION_DECAY_FACTOR));
}

/**
 * @param {string} section
 * @returns {Tier}
 */
export function inferTierFromSection(section) {
    if (section === 'working') return 'working';
    if (section === 'history') return 'history';
    return 'long_term';
}

/**
 * @param {string} section
 * @returns {Status}
 */
export function inferStatusFromSection(section) {
    return section === 'history' ? 'superseded' : 'active';
}

/**
 * @param {string} value
 * @returns {Tier}
 */
export function normalizeTierToSection(value) {
    const tier = normalizeTier(value);
    if (tier === 'working') return 'working';
    if (tier === 'history') return 'history';
    return 'long_term';
}

/**
 * @param {Partial<Bullet>} bullet
 * @param {Tier} [fallback]
 * @returns {Tier}
 */
export function inferTierFromBullet(bullet, fallback = 'long_term') {
    if (bullet?.reviewAt || bullet?.expiresAt) return 'working';

    const text = String(bullet?.text || '').toLowerCase();
    if (!text) return fallback;

    const workingPatterns = [
        /\bcurrently\b/,
        /\bright now\b/,
        /\bthis (week|month|quarter|year)\b/,
        /\bnext (week|month|quarter|year)\b/,
        /\bplanning\b/,
        /\bevaluating\b/,
        /\bconsidering\b/,
        /\btrying to\b/,
        /\bworking on\b/,
        /\bdebugging\b/,
        /\bpreparing\b/,
        /\binterviewing\b/,
        /\bin progress\b/,
        /\btemporary\b/,
        /\bfor now\b/,
        /\bas of \d{4}-\d{2}-\d{2}\b/
    ];

    return workingPatterns.some((pattern) => pattern.test(text)) ? 'working' : fallback;
}

/**
 * @param {Partial<Bullet>} bullet
 * @param {EnsureBulletMetadataOptions} [options]
 * @returns {Bullet}
 */
export function ensureBulletMetadata(bullet, options = {}) {
    const fallbackTopic = normalizeTopic(options.defaultTopic || 'general');
    const fallbackUpdatedAt = options.updatedAt || nowIsoDateTime();
    const inferredTier = inferTierFromBullet(bullet, options.defaultTier || 'long_term');
    const preferredTier = bullet?.explicitTier ? bullet?.tier : inferredTier;
    const fallbackTier = normalizeTier(options.defaultTier || preferredTier || bullet?.tier || 'long_term');
    const fallbackStatus = normalizeStatus(
        options.defaultStatus
            || (bullet?.explicitStatus ? bullet?.status : null)
            || inferStatusFromSection(normalizeTierToSection(fallbackTier))
    );
    return {
        text: String(bullet?.text || '').trim(),
        topic: normalizeTopic(bullet?.topic || fallbackTopic, fallbackTopic),
        updatedAt: safeDateTimeIso(bullet?.updatedAt) || fallbackUpdatedAt,
        expiresAt: safeDateIso(bullet?.expiresAt),
        reviewAt: safeDateIso(bullet?.reviewAt),
        tier: normalizeTier(preferredTier, fallbackTier),
        status: normalizeStatus(bullet?.status, fallbackStatus),
        source: normalizeSource(
            bullet?.source,
            normalizeSource(options.defaultSource, 'user_statement')
        ),
        confidence: normalizeConfidence(
            bullet?.confidence,
            normalizeConfidence(
                options.defaultConfidence,
                defaultConfidenceForSource(normalizeSource(
                    bullet?.source,
                    normalizeSource(options.defaultSource, 'user_statement')
                ))
            )
        ),
        explicitTier: Boolean(bullet?.explicitTier || bullet?.tier),
        explicitStatus: Boolean(bullet?.explicitStatus || bullet?.status),
        explicitSource: Boolean(bullet?.explicitSource || bullet?.source),
        explicitConfidence: Boolean(bullet?.explicitConfidence || bullet?.confidence),
        heading: String(bullet?.heading || 'General'),
        section: normalizeTierToSection(preferredTier || fallbackTier),
        lineIndex: Number.isFinite(bullet?.lineIndex) ? /** @type {number} */ (bullet.lineIndex) : 0
    };
}

/**
 * @param {Bullet} bullet
 * @param {string} [today]
 * @returns {boolean}
 */
export function isExpiredBullet(bullet, today = todayIsoDate()) {
    if (!bullet?.expiresAt) return false;
    return String(bullet.expiresAt) < String(today);
}

/**
 * Parsing and rendering for memory bullets.
 */
/** @import { Bullet } from '../types.js' */
import {
    safeDateIso,
    normalizeTier,
    normalizeStatus,
    normalizeSource,
    normalizeConfidence,
    normalizeTopic,
    normalizeTierToSection,
    inferTierFromSection,
    inferStatusFromSection,
    ensureBulletMetadata,
} from './normalize.js';

const BULLET_REGEX = /^\s*-\s+(.*)$/;
const HEADING_REGEX = /^\s{0,3}#{1,6}\s+(.*)$/;

/**
 * @param {string} content
 * @returns {Bullet[]}
 */
export function parseBullets(content) {
    const lines = String(content || '').split('\n');
    const bullets = [];
    let currentHeading = 'General';
    let section = 'long_term';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = line.match(HEADING_REGEX);
        if (headingMatch) {
            currentHeading = headingMatch[1].trim() || currentHeading;
            if (/^working/i.test(currentHeading)) {
                section = 'working';
            } else if (/^(long[- ]?term|active)/i.test(currentHeading)) {
                section = 'long_term';
            } else if (/^(history|archive)/i.test(currentHeading)) {
                section = 'history';
            }
            continue;
        }

        const bulletMatch = line.match(BULLET_REGEX);
        if (!bulletMatch) continue;

        const raw = bulletMatch[1].trim();
        const parts = raw.split('|').map((part) => part.trim()).filter(Boolean);
        if (parts.length === 0) continue;

        const text = parts.shift() || '';
        let topic = null;
        let updatedAt = null;
        let expiresAt = null;
        let reviewAt = null;
        let tier = null;
        let status = null;
        let source = null;
        let confidence = null;

        for (const part of parts) {
            const kv = part.match(/^([a-z_]+)\s*=\s*(.+)$/i);
            if (!kv) continue;
            const key = kv[1].toLowerCase();
            const value = kv[2].trim();
            if (key === 'topic') topic = value;
            if (key === 'updated_at') updatedAt = safeDateIso(value);
            if (key === 'expires_at') expiresAt = safeDateIso(value);
            if (key === 'review_at') reviewAt = safeDateIso(value);
            if (key === 'tier') tier = normalizeTier(value);
            if (key === 'status') status = normalizeStatus(value);
            if (key === 'source') source = normalizeSource(value);
            if (key === 'confidence') confidence = normalizeConfidence(value);
        }

        bullets.push({
            text,
            topic: topic ? normalizeTopic(topic) : null,
            updatedAt,
            expiresAt,
            reviewAt,
            tier: tier || inferTierFromSection(section),
            status: status || inferStatusFromSection(section),
            source: source || null,
            confidence: confidence || null,
            explicitTier: Boolean(tier),
            explicitStatus: Boolean(status),
            explicitSource: Boolean(source),
            explicitConfidence: Boolean(confidence),
            heading: currentHeading,
            section,
            lineIndex: i
        });
    }

    return bullets;
}

/**
 * @param {string} content
 * @returns {number}
 */
export function countBullets(content) {
    return parseBullets(content).length;
}

/**
 * @param {string} content
 * @returns {string[]}
 */
export function extractTitles(content) {
    const lines = String(content || '').split('\n');
    const titles = [];

    for (const line of lines) {
        const headingMatch = line.match(HEADING_REGEX);
        if (!headingMatch) continue;

        const title = headingMatch[1].trim();
        if (!title) continue;
        if (/^(working|long[- ]?term|history|active|archive)/i.test(title)) continue;
        titles.push(title);
    }

    return titles;
}

/**
 * @param {Partial<Bullet>} bullet
 * @returns {string}
 */
export function renderBullet(bullet) {
    const clean = ensureBulletMetadata(bullet);
    const metadata = [
        `topic=${clean.topic}`,
        `tier=${clean.tier}`,
        `status=${clean.status}`,
        `source=${clean.source}`,
        `confidence=${clean.confidence}`,
        `updated_at=${clean.updatedAt}`
    ];
    if (clean.reviewAt) metadata.push(`review_at=${clean.reviewAt}`);
    if (clean.expiresAt) metadata.push(`expires_at=${clean.expiresAt}`);
    return `- ${clean.text} | ${metadata.join(' | ')}`;
}

function topicHeading(topic) {
    const clean = String(topic || 'general').trim();
    if (!clean) return 'General';
    return clean
        .split(/[\/_-]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function inferDocumentTopic(bullets, fallback = 'general') {
    const firstTopic = (bullets || []).find((bullet) => bullet?.topic)?.topic;
    return firstTopic || fallback;
}

function renderSection(lines, title, bullets, forceHistory = false) {
    lines.push(`## ${title}`);

    if (!bullets || bullets.length === 0) {
        lines.push('_No entries yet._');
        return;
    }

    for (const bullet of bullets) {
        const nextBullet = forceHistory
            ? { ...bullet, tier: 'history', status: bullet.status === 'active' ? 'superseded' : bullet.status, section: 'history' }
            : bullet;
        lines.push(renderBullet(nextBullet));
    }
}

/**
 * @param {Bullet[]} working
 * @param {Bullet[]} longTerm
 * @param {Bullet[]} history
 * @param {{ titleTopic?: string }} [options]
 * @returns {string}
 */
export function renderCompactedDocument(working, longTerm, history, options = {}) {
    const lines = [];
    const docTopic = normalizeTopic(options.titleTopic || inferDocumentTopic([...working, ...longTerm, ...history], 'general'));
    lines.push(`# Memory: ${topicHeading(docTopic)}`);
    lines.push('');
    renderSection(lines, 'Working memory (current context subject to change)', working);
    lines.push('');
    renderSection(lines, 'Long-term memory (stable facts that are unlikely to change)', longTerm);
    lines.push('');
    renderSection(lines, 'History (no longer current)', history, true);

    return lines.join('\n').trim();
}

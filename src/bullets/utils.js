/**
 * Helpers for metadata-rich memory bullets.
 * Bullet format:
 * - Fact text | topic=foo | tier=long_term | status=active | updated_at=YYYY-MM-DD
 */

const BULLET_REGEX = /^\s*-\s+(.*)$/;
const HEADING_REGEX = /^\s{0,3}#{1,6}\s+(.*)$/;

function safeDateIso(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

export function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
}

export function inferTopicFromPath(path) {
    if (!path || typeof path !== 'string') return 'general';
    const first = path.split('/')[0]?.trim().toLowerCase();
    return first || 'general';
}

export function normalizeTopic(value, fallback = 'general') {
    const source = String(value || '').trim().toLowerCase();
    const normalized = source
        .replace(/[^a-z0-9/_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-/]+|[-/]+$/g, '');
    return normalized || fallback;
}

export function normalizeFactText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeTier(value, fallback = 'long_term') {
    const source = String(value || '').trim().toLowerCase();
    if (['working', 'short_term', 'short-term'].includes(source)) return 'working';
    if (['long_term', 'long-term', 'longterm', 'active'].includes(source)) return 'long_term';
    if (['history', 'archive', 'archived'].includes(source)) return 'history';
    return fallback;
}

export function normalizeStatus(value, fallback = 'active') {
    const source = String(value || '').trim().toLowerCase();
    if (['active', 'current'].includes(source)) return 'active';
    if (['superseded', 'replaced', 'resolved'].includes(source)) return 'superseded';
    if (['expired', 'stale'].includes(source)) return 'expired';
    if (['uncertain', 'tentative'].includes(source)) return 'uncertain';
    return fallback;
}

function inferTierFromSection(section) {
    if (section === 'working') return 'working';
    if (section === 'history') return 'history';
    return 'long_term';
}

function inferStatusFromSection(section) {
    return section === 'history' ? 'superseded' : 'active';
}

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

export function parseMemoryBullets(content) {
    const lines = String(content || '').split('\n');
    const bullets = [];
    let currentHeading = 'General';
    let section = 'long_term';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = line.match(HEADING_REGEX);
        if (headingMatch) {
            currentHeading = headingMatch[1].trim() || currentHeading;
            if (/^(working)$/i.test(currentHeading)) {
                section = 'working';
            } else if (/^(long[- ]?term|active)$/i.test(currentHeading)) {
                section = 'long_term';
            } else if (/^(history|archive)$/i.test(currentHeading)) {
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
        }

        bullets.push({
            text,
            topic: topic ? normalizeTopic(topic) : null,
            updatedAt,
            expiresAt,
            reviewAt,
            tier: tier || inferTierFromSection(section),
            status: status || inferStatusFromSection(section),
            explicitTier: Boolean(tier),
            explicitStatus: Boolean(status),
            heading: currentHeading,
            section,
            lineIndex: i
        });
    }

    return bullets;
}

export function countMemoryBullets(content) {
    return parseMemoryBullets(content).length;
}

export function extractMemoryTitles(content) {
    const lines = String(content || '').split('\n');
    const titles = [];

    for (const line of lines) {
        const headingMatch = line.match(HEADING_REGEX);
        if (!headingMatch) continue;

        const title = headingMatch[1].trim();
        if (!title) continue;
        if (/^(working|long[- ]?term|history|active|archive|current context|stable facts|no longer current)$/i.test(title)) continue;
        titles.push(title);
    }

    return titles;
}

export function ensureBulletMetadata(bullet, options = {}) {
    const fallbackTopic = normalizeTopic(options.defaultTopic || 'general');
    const fallbackUpdatedAt = options.updatedAt || todayIsoDate();
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
        updatedAt: safeDateIso(bullet?.updatedAt) || fallbackUpdatedAt,
        expiresAt: safeDateIso(bullet?.expiresAt),
        reviewAt: safeDateIso(bullet?.reviewAt),
        tier: normalizeTier(preferredTier, fallbackTier),
        status: normalizeStatus(bullet?.status, fallbackStatus),
        section: normalizeTierToSection(preferredTier || fallbackTier)
    };
}

export function renderMemoryBullet(bullet) {
    const clean = ensureBulletMetadata(bullet);
    const metadata = [
        `topic=${clean.topic}`,
        `tier=${clean.tier}`,
        `status=${clean.status}`,
        `updated_at=${clean.updatedAt}`
    ];
    if (clean.reviewAt) metadata.push(`review_at=${clean.reviewAt}`);
    if (clean.expiresAt) metadata.push(`expires_at=${clean.expiresAt}`);
    return `- ${clean.text} | ${metadata.join(' | ')}`;
}

export function scoreMemoryBullet(bullet, queryTerms = []) {
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
    return score;
}

export function tokenizeQuery(query) {
    return String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3);
}

export function isExpiredBullet(bullet, today = todayIsoDate()) {
    if (!bullet?.expiresAt) return false;
    return String(bullet.expiresAt) < String(today);
}

export function normalizeTierToSection(value) {
    const tier = normalizeTier(value);
    if (tier === 'working') return 'working';
    if (tier === 'history') return 'history';
    return 'long_term';
}

export function compactBullets(bullets, options = {}) {
    const today = options.today || todayIsoDate();
    const maxActivePerTopic = Number.isFinite(options.maxActivePerTopic)
        ? Math.max(1, options.maxActivePerTopic)
        : 24;
    const defaultTopic = normalizeTopic(options.defaultTopic || 'general');

    // Deduplicate by normalized fact text; keep newest by updatedAt.
    const dedup = new Map();
    for (const original of bullets) {
        const normalized = ensureBulletMetadata(original, { defaultTopic, updatedAt: today });
        const key = normalizeFactText(normalized.text);
        if (!key) continue;

        const existing = dedup.get(key);
        if (!existing) {
            dedup.set(key, normalized);
            continue;
        }

        const existingDate = existing.updatedAt || '0000-00-00';
        const incomingDate = normalized.updatedAt || '0000-00-00';
        if (incomingDate >= existingDate) {
            dedup.set(key, normalized);
        }
    }

    const working = [];
    const longTerm = [];
    const history = [];

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

    for (const [topic, list] of byTopic.entries()) {
        list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        const keep = list.slice(0, maxActivePerTopic);
        const extra = list.slice(maxActivePerTopic);
        keep.forEach((item) => {
            if (item.tier === 'working') {
                working.push({ ...item, topic, tier: 'working', status: item.status || 'active', section: 'working' });
            } else {
                longTerm.push({ ...item, topic, tier: 'long_term', status: item.status || 'active', section: 'long_term' });
            }
        });
        extra.forEach((item) => {
            history.push({ ...item, topic, tier: 'history', status: 'superseded', section: 'history' });
        });
    }

    history.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    working.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    longTerm.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    return {
        working,
        longTerm,
        history,
        active: [...working, ...longTerm],
        archive: history
    };
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

function renderSection(lines, title, subsectionTitle, bullets, forceHistory = false) {
    lines.push(`## ${title}`);
    lines.push(`### ${subsectionTitle}`);

    if (!bullets || bullets.length === 0) {
        lines.push('_No entries yet._');
        return;
    }

    for (const bullet of bullets) {
        const nextBullet = forceHistory
            ? { ...bullet, tier: 'history', status: bullet.status === 'active' ? 'superseded' : bullet.status, section: 'history' }
            : bullet;
        lines.push(renderMemoryBullet(nextBullet));
    }
}

export function renderCompactedMemoryDocument(working, longTerm, history, options = {}) {
    const lines = [];
    const docTopic = normalizeTopic(options.titleTopic || inferDocumentTopic([...working, ...longTerm, ...history], 'general'));
    lines.push(`# Memory: ${topicHeading(docTopic)}`);
    lines.push('');
    renderSection(lines, 'Working', 'Current context', working);
    lines.push('');
    renderSection(lines, 'Long-Term', 'Stable facts', longTerm);
    lines.push('');
    renderSection(lines, 'History', 'No longer current', history, true);

    return lines.join('\n').trim();
}

/**
 * MemoryCompactor — Periodic dedup + archive of stale facts.
 *
 * Two-phase compaction:
 *   1. Deterministic — dedup, tier assignment, expiry (no LLM, cheap)
 *   2. Semantic review — LLM pass on Working bullets only, to catch stale
 *      plans/goals that deterministic logic can't detect. Uses cross-file
 *      oneLiner summaries as context so inter-file resolutions are visible.
 *
 * Unstructured/legacy files use a full LLM rewrite (existing behaviour).
 *
 * Usage:
 * - compactAll(): Force-compact all memory files immediately.
 * - maybeCompact(): Only runs if >=6 hours have passed since last run.
 */
/** @import { LLMClient, StorageBackend } from '../types.js' */
import {
    compactBullets,
    inferTopicFromPath,
    isExpiredBullet,
    parseBullets,
    todayIsoDate,
    nowIsoDateTime,
    renderCompactedDocument
} from '../internal/format/index.js';
import { compactionPrompt, semanticReviewPrompt } from '../prompts/compaction.js';
import { DIRECT_LLM_OUTPUT_TOKENS } from '../internal/limits.js';


const MAX_FILE_CHARS = 8000;

// ─── Compactor ───────────────────────────────────────────────────

class MemoryCompactor {
    constructor({ backend, bulletIndex, llmClient, model, onProgress }) {
        this._backend = backend;
        this._bulletIndex = bulletIndex;
        this._llmClient = llmClient;
        this._model = model;
        this._onProgress = onProgress || null;
        this._running = false;
        this._fileSummaries = [];
    }

    async compactAll() {
        if (this._running) return;
        this._running = true;
        try {
            await this._backend.init();
            const allFiles = await this._backend.exportAll();
            const realFiles = allFiles.filter((file) => !file.path.endsWith('_tree.md'));

            // Collect one-liner summaries for cross-file context in semantic review.
            this._fileSummaries = realFiles
                .filter(f => f.oneLiner)
                .map(f => ({ path: f.path, oneLiner: f.oneLiner }));

            let filesChanged = 0;
            const total = realFiles.length;

            for (let i = 0; i < total; i++) {
                const file = realFiles[i];
                this._onProgress?.({ stage: 'file', file: file.path, current: i + 1, total });

                const compacted = await this._compactFile(file.path, file.content || '');
                if (!compacted) continue;
                if (compacted.trim() === String(file.content || '').trim()) continue;
                await this._backend.write(file.path, compacted);
                await this._bulletIndex.refreshPath(file.path);
                filesChanged++;
            }

            return { filesChanged, filesTotal: total };

        } finally {
            this._running = false;
            this._fileSummaries = [];
        }
    }

    async pruneExpired() {
        await this._backend.init();
        const allFiles = await this._backend.exportAll();
        const realFiles = allFiles.filter(f => !f.path.endsWith('_tree.md'));

        const today = todayIsoDate();
        let totalArchived = 0;
        let filesChanged = 0;

        for (const file of realFiles) {
            const raw = String(file.content || '').trim();
            if (!raw) continue;

            const bullets = parseBullets(raw);
            if (bullets.length === 0) continue;

            const toExpire = bullets.filter(b =>
                b.section !== 'history' &&
                b.status !== 'expired' &&
                b.status !== 'superseded' &&
                isExpiredBullet(b, today)
            );
            if (toExpire.length === 0) continue;

            const expireLineIndexes = new Set(toExpire.map(b => b.lineIndex));
            const marked = bullets.map(b =>
                expireLineIndexes.has(b.lineIndex) ? { ...b, status: 'expired' } : b
            );

            const defaultTopic = inferTopicFromPath(file.path);
            const compacted = compactBullets(marked, { defaultTopic });
            const rendered = renderCompactedDocument(
                compacted.working, compacted.longTerm, compacted.history,
                { titleTopic: defaultTopic }
            );

            if (rendered.trim() === raw) continue;

            await this._backend.write(file.path, rendered);
            await this._bulletIndex.refreshPath(file.path);
            totalArchived += toExpire.length;
            filesChanged++;
        }

        return { archived: totalArchived, filesChanged };
    }

    async _compactFile(path, content) {
        const raw = String(content || '').trim();
        if (!raw) return null;

        const parsed = parseBullets(raw);

        // Unstructured/legacy files: full LLM rewrite (unchanged behaviour).
        if (parsed.length === 0) {
            return this._llmRewrite(path, raw);
        }

        // Phase 1: deterministic dedup, tier assignment, expiry.
        const defaultTopic = inferTopicFromPath(path);
        const det = compactBullets(parsed, { defaultTopic });
        const deduplicated = parsed.length - (det.working.length + det.longTerm.length + det.history.length);
        const expired = det.history.filter(b => b.status === 'expired').length;

        // Phase 2: semantic review of Working bullets.
        // Only fires when Working bullets exist — skipped for stable long-term-only files.
        let working = det.working;
        let superseded = 0;
        if (working.length > 0) {
            this._onProgress?.({ stage: 'semantic', file: path });
            working = await this._semanticReviewWorking(working, det.longTerm, path);
            superseded = working.filter(b => b.status === 'superseded').length;
        }

        // Re-run deterministic compaction so newly-superseded bullets flow to History.
        const allBullets = [...working, ...det.longTerm, ...det.history];
        const final = compactBullets(allBullets, { defaultTopic });

        this._onProgress?.({ stage: 'file_done', file: path, deduplicated, superseded, expired });

        return renderCompactedDocument(
            final.working, final.longTerm, final.history,
            { titleTopic: defaultTopic }
        );
    }

    /**
     * Ask the LLM which Working bullets are now stale/completed/superseded.
     * Returns the same array with superseded bullets marked status=superseded.
     */
    async _semanticReviewWorking(working, longTerm, path) {
        const numberedBullets = working
            .map((b, i) => `${i + 1}: ${b.text}`)
            .join('\n');

        const longTermSection = longTerm.length > 0
            ? `Long-term facts in this file (for resolution context):\n${longTerm.map(b => `- ${b.text}`).join('\n')}\n\n`
            : '';

        // Cross-file context: exclude this file's own summary.
        const otherFiles = this._fileSummaries.filter(f => f.path !== path);
        const fileSummariesSection = otherFiles.length > 0
            ? `Other memory files:\n${otherFiles.map(f => `- ${f.path}: ${f.oneLiner}`).join('\n')}\n\n`
            : '';

        const prompt = semanticReviewPrompt
            .replace('{TODAY}', todayIsoDate())
            .replace('{FILE_SUMMARIES_SECTION}', fileSummariesSection)
            .replace('{LONG_TERM_SECTION}', longTermSection)
            .replace('{NUMBERED_BULLETS}', numberedBullets);

        let responseText = '';
        try {
            const response = await this._llmClient.createChatCompletion({
                model: this._model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: DIRECT_LLM_OUTPUT_TOKENS.compactionSemanticReview,
                temperature: 0,
            });
            responseText = response.content || '';
        } catch {
            // On failure, leave Working bullets unchanged rather than silently corrupting data.
            return working;
        }

        // Parse "N: KEEP" / "N: SUPERSEDED — reason" lines.
        const decisions = new Map();
        for (const line of responseText.split('\n')) {
            const match = line.match(/^(\d+)\s*:\s*(KEEP|SUPERSEDED)/i);
            if (match) {
                decisions.set(parseInt(match[1], 10), match[2].toUpperCase());
            }
        }

        return working.map((b, i) => {
            if (decisions.get(i + 1) === 'SUPERSEDED') {
                return { ...b, status: 'superseded', tier: 'history', section: 'history' };
            }
            return b;
        });
    }

    async _llmRewrite(path, raw) {
        const prompt = compactionPrompt
            .replace('{NOW}', nowIsoDateTime())
            .replace('{PATH}', path)
            .replace('{CONTENT}', raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(truncated)' : raw);

        const response = await this._llmClient.createChatCompletion({
            model: this._model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: DIRECT_LLM_OUTPUT_TOKENS.compactionRewrite,
            temperature: 0,
        });

        const text = (response.content || '').trim();
        return text || null;
    }
}

export { MemoryCompactor };

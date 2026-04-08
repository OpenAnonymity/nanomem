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
    parseBullets,
    todayIsoDate,
    renderCompactedDocument
} from '../bullets/index.js';


const MAX_FILE_CHARS = 8000;

// ─── Prompts ─────────────────────────────────────────────────────

const COMPACTION_PROMPT = `You are compacting a markdown memory file into a stable memory format.

Input is one memory file. Rewrite it into:

# Memory: <Topic>

## Working
### <Topic>
- fact | topic=<topic> | tier=working | status=active | source=user_statement|assistant_summary|inference|system | confidence=high|medium|low | updated_at=YYYY-MM-DD | review_at=YYYY-MM-DD(optional) | expires_at=YYYY-MM-DD(optional)

## Long-Term
### <Topic>
- fact | topic=<topic> | tier=long_term | status=active | source=user_statement|assistant_summary|inference|system | confidence=high|medium|low | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD(optional)

## History
### <Topic>
- fact | topic=<topic> | tier=history | status=superseded|expired|uncertain | source=user_statement|assistant_summary|inference|system | confidence=high|medium|low | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD(optional)

Rules:
- Keep only concrete reusable facts.
- Merge semantic duplicates and keep the most recent/best phrasing.
- Resolve contradictions: newer user statements beat older ones; user statements beat inferences; higher confidence beats lower.
- Put stable facts in Long-Term: identity/background, durable preferences, recurring constraints, persistent health facts, long-running roles, durable relationships.
- Put temporary or in-progress context in Working: active plans, current tasks, temporary situations, near-term goals.
- Expired facts (expires_at in the past) go to History with status=expired.
- Working facts should include review_at or expires_at when possible.
- Keep Working concise. Move stale/low-priority facts to History.
- Preserve meaning; do not invent facts.
- Output markdown only (no fences, no explanations).

Today: {TODAY}
Path: {PATH}

File content:
\`\`\`
{CONTENT}
\`\`\``;

/**
 * Targeted semantic review of Working bullets only.
 * Output is minimal (KEEP/SUPERSEDED per bullet) to keep cost low.
 */
const SEMANTIC_REVIEW_PROMPT = `Today is {TODAY}. Review these short-term (Working) memory bullets and identify which are stale, completed, or superseded.

{FILE_SUMMARIES_SECTION}{LONG_TERM_SECTION}Working bullets to review:
{NUMBERED_BULLETS}

For each numbered bullet, output exactly one line in the format:
N: KEEP
or
N: SUPERSEDED — brief reason

Output only these lines, one per bullet, nothing else.`;

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

        const prompt = SEMANTIC_REVIEW_PROMPT
            .replace('{TODAY}', todayIsoDate())
            .replace('{FILE_SUMMARIES_SECTION}', fileSummariesSection)
            .replace('{LONG_TERM_SECTION}', longTermSection)
            .replace('{NUMBERED_BULLETS}', numberedBullets);

        let responseText = '';
        try {
            const response = await this._llmClient.createChatCompletion({
                model: this._model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 6000,
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
        const prompt = COMPACTION_PROMPT
            .replace('{TODAY}', todayIsoDate())
            .replace('{PATH}', path)
            .replace('{CONTENT}', raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(truncated)' : raw);

        const response = await this._llmClient.createChatCompletion({
            model: this._model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1800,
            temperature: 0,
        });

        const text = (response.content || '').trim();
        return text || null;
    }
}

export { MemoryCompactor };

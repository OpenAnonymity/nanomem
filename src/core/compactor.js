/**
 * MemoryCompactor — Periodic dedup + archive of stale facts.
 *
 * Uses an LLM to rewrite each memory file into a stable Working/Long-Term/History format,
 * merging duplicates, resolving conflicts, and moving expired facts to History.
 *
 * Usage:
 * - compactAll(): Force-compact all memory files immediately.
 * - maybeCompact(): Only runs if ≥6 hours have passed since last run (opportunistic).
 *   Call this at convenient trigger points (after extraction, on app load, etc.).
 *   There is no built-in timer — the caller decides when to invoke this.
 */
import {
    compactBullets,
    inferTopicFromPath,
    parseMemoryBullets,
    renderCompactedMemoryDocument
} from '../bullets/utils.js';


const COMPACT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_FILE_CHARS = 8000;

const COMPACTION_PROMPT = `You are compacting a markdown memory file into a stable memory format.

Input is one memory file. Rewrite it into:

# Memory: <Topic>

## Working
### <Topic>
- fact | topic=<topic> | tier=working | status=active | updated_at=YYYY-MM-DD | review_at=YYYY-MM-DD(optional) | expires_at=YYYY-MM-DD(optional)

## Long-Term
### <Topic>
- fact | topic=<topic> | tier=long_term | status=active | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD(optional)

## History
### <Topic>
- fact | topic=<topic> | tier=history | status=superseded|expired|uncertain | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD(optional)

Rules:
- Keep only concrete reusable facts.
- Merge semantic duplicates and keep the most recent/best phrasing.
- Resolve contradictions by keeping the most recently updated current fact; older conflicting facts go to History.
- Put stable facts in Long-Term: identity/background, durable preferences, recurring constraints, persistent health facts, long-running roles, durable relationships, and ongoing defaults.
- Put temporary or in-progress context in Working: active plans, current tasks, temporary situations, and near-term goals.
- If a fact is both current and durable, prefer Long-Term unless the short-term state is the useful part.
- Expired facts (expires_at in the past) go to History with status=expired.
- Working facts should include review_at or expires_at when possible.
- Keep Working concise. Move stale/low-priority/older overflow facts to History.
- Preserve meaning; do not invent facts.
- Output markdown only (no fences, no explanations).

Today: {TODAY}
Path: {PATH}

File content:
\`\`\`
{CONTENT}
\`\`\``;

class MemoryCompactor {
    constructor({ backend, bulletIndex, llmClient, model }) {
        this._backend = backend;
        this._bulletIndex = bulletIndex;
        this._llmClient = llmClient;
        this._model = model;
        this._lastRunAt = 0;
        this._running = false;
    }

    async maybeCompact() {
        if (this._running) return;
        const now = Date.now();
        if (now - this._lastRunAt < COMPACT_INTERVAL_MS) return;
        await this.compactAll();
    }

    async compactAll() {
        if (this._running) return;
        this._running = true;
        try {
            await this._backend.init();
            const allFiles = await this._backend.exportAll();
            const realFiles = allFiles.filter((file) => !file.path.endsWith('_index.md'));
            let changed = 0;

            for (const file of realFiles) {
                const compacted = await this._compactFileWithLlm(file.path, file.content || '');
                if (!compacted) continue;
                const original = String(file.content || '').trim();
                if (compacted.trim() === original) continue;
                await this._backend.write(file.path, compacted);
                await this._bulletIndex.refreshPath(file.path);
                changed += 1;
            }

            this._lastRunAt = Date.now();
        } finally {
            this._running = false;
        }
    }

    async _compactFileWithLlm(path, content) {
        const raw = String(content || '').trim();
        if (!raw) return null;

        const parsed = parseMemoryBullets(raw);
        if (parsed.length > 0) {
            const defaultTopic = inferTopicFromPath(path);
            const compacted = compactBullets(parsed, { defaultTopic });
            return renderCompactedMemoryDocument(
                compacted.working,
                compacted.longTerm,
                compacted.history,
                { titleTopic: defaultTopic }
            );
        }

        const prompt = COMPACTION_PROMPT
            .replace('{TODAY}', new Date().toISOString().slice(0, 10))
            .replace('{PATH}', path)
            .replace('{CONTENT}', raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n...(truncated)' : raw);

        const response = await this._llmClient.createChatCompletion({
            model: this._model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1800,
            temperature: 0,
        });

        const text = (response.content || '').trim();
        if (!text) return null;
        return text;
    }
}

export { MemoryCompactor };

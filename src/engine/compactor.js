/**
 * MemoryCompactor — Periodic dedup + archive of stale facts.
 *
 * Uses deterministic compaction for structured files, LLM rewrite for legacy files.
 *
 * Usage:
 * - compactAll(): Force-compact all memory files immediately.
 * - maybeCompact(): Only runs if >=6 hours have passed since last run.
 */
import {
    compactBullets,
    inferTopicFromPath,
    parseBullets,
    todayIsoDate,
    renderCompactedDocument
} from '../bullets/index.js';


const MAX_FILE_CHARS = 8000;

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

class MemoryCompactor {
    constructor({ backend, bulletIndex, llmClient, model }) {
        this._backend = backend;
        this._bulletIndex = bulletIndex;
        this._llmClient = llmClient;
        this._model = model;
        this._running = false;
    }

    async compactAll() {
        if (this._running) return;
        this._running = true;
        try {
            await this._backend.init();
            const allFiles = await this._backend.exportAll();
            const realFiles = allFiles.filter((file) => !file.path.endsWith('_tree.md'));

            for (const file of realFiles) {
                const compacted = await this._compactFile(file.path, file.content || '');
                if (!compacted) continue;
                if (compacted.trim() === String(file.content || '').trim()) continue;
                await this._backend.write(file.path, compacted);
                await this._bulletIndex.refreshPath(file.path);
            }

        } finally {
            this._running = false;
        }
    }

    async _compactFile(path, content) {
        const raw = String(content || '').trim();
        if (!raw) return null;

        // Structured files: deterministic local compaction.
        const parsed = parseBullets(raw);
        if (parsed.length > 0) {
            const defaultTopic = inferTopicFromPath(path);
            const compacted = compactBullets(parsed, { defaultTopic });
            return renderCompactedDocument(
                compacted.working, compacted.longTerm, compacted.history,
                { titleTopic: defaultTopic }
            );
        }

        // Unstructured/legacy files: LLM rewrite.
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
        if (!text) return null;
        return text;
    }
}

export { MemoryCompactor };

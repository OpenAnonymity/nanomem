/**
 * Prompts for memory file compaction and semantic review.
 *
 * compactionPrompt      — rewrites a memory file into the canonical tiered format
 *                         (Working / Long-term / History).
 * semanticReviewPrompt  — lightweight review of Working bullets to identify stale,
 *                         completed, or superseded entries.
 */

export const compactionPrompt = `You are compacting a markdown memory file into a stable memory format.

Input is one memory file. Rewrite it into:

# Memory: <Topic>

## Working memory (current context subject to change)
- fact | topic=<topic> | tier=working | status=active | source=user_statement|assistant_summary|inference|system | confidence=high|medium|low | updated_at=YYYY-MM-DD | review_at=YYYY-MM-DD(optional) | expires_at=YYYY-MM-DD(optional)

## Long-term memory (stable facts that are unlikely to change)
- fact | topic=<topic> | tier=long_term | status=active | source=user_statement|assistant_summary|inference|system | confidence=high|medium|low | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD(optional)

## History (no longer current)
- fact | topic=<topic> | tier=history | status=superseded|expired|uncertain | source=user_statement|assistant_summary|inference|system | confidence=high|medium|low | updated_at=YYYY-MM-DD | expires_at=YYYY-MM-DD(optional)

Rules:
- Write facts in a timeless, archival format: use absolute dates (YYYY-MM-DD) rather than relative terms like "recently", "currently", "just", or "last week". A fact must be interpretable correctly even years after it was written.
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

export const semanticReviewPrompt = `Today is {TODAY}. Review these short-term (Working) memory bullets and identify which are stale, completed, or superseded.

{FILE_SUMMARIES_SECTION}{LONG_TERM_SECTION}Working bullets to review:
{NUMBERED_BULLETS}

For each numbered bullet, output exactly one line in the format:
N: KEEP
or
N: SUPERSEDED — brief reason

Output only these lines, one per bullet, nothing else.`;

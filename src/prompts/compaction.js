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
- fact | topic=<topic> | tier=working | status=active | source=user_statement|llm_infer|document | confidence=SCORE | updated_at=YYYY-MM-DDTHH:MM | review_at=YYYY-MM-DD(optional) | expires_at=YYYY-MM-DD(optional)

## Long-term memory (stable facts that are unlikely to change)
- fact | topic=<topic> | tier=long_term | status=active | source=user_statement|llm_infer|document | confidence=SCORE | updated_at=YYYY-MM-DDTHH:MM | expires_at=YYYY-MM-DD(optional)

## History (no longer current)
- fact | topic=<topic> | tier=history | status=superseded|expired|uncertain | source=user_statement|llm_infer|document | confidence=SCORE | updated_at=YYYY-MM-DDTHH:MM | expires_at=YYYY-MM-DD(optional)

Rules:
- Write facts in a timeless, archival format: use absolute dates (YYYY-MM-DD) rather than relative terms like "recently", "currently", "just", or "last week". A fact must be interpretable correctly even years after it was written.
- Keep only concrete reusable facts.
- Merge semantic duplicates and keep the most recent/best phrasing.
- Resolve contradictions: newer user statements beat older ones; user statements beat inferences; higher confidence beats lower.
- Preserve existing numeric confidence values exactly when possible. SCORE is a number from 0.0 to 1.0. Do not collapse numeric scores into high/medium/low.
- Do not promote a fact to confidence near 1.0 unless it is a direct, explicit user statement. Inferences (llm_infer), plans, and habits should usually remain below 0.8 even after compaction.
- Put stable facts in Long-Term: identity/background, durable preferences, recurring constraints, persistent health facts, long-running roles, durable relationships.
- Put temporary or in-progress context in Working: active plans, current tasks, temporary situations, near-term goals.
- Expired facts (expires_at in the past) go to History with status=expired.
- Working facts should include review_at or expires_at when possible.
- Keep Working concise. Move stale/low-priority facts to History.
- Preserve meaning; do not invent facts.
- Output markdown only (no fences, no explanations).

Now: {NOW}
Path: {PATH}

File content:
\`\`\`
{CONTENT}
\`\`\``;

export const contradictionReviewPrompt = `Today is {TODAY}. Review these active memory bullets and identify contradicting pairs — two bullets that assert different current values for the same type of fact (e.g. two different current jobs, two different home cities, two different current tech stacks).

Active bullets:
{NUMBERED_BULLETS}

Rules:
- Default to KEEP. Only mark SUPERSEDED when you are certain of a direct contradiction — two bullets claiming different values for the same singleton attribute at the same point in time. Uncertainty means KEEP.
- When two bullets genuinely contradict, always mark the one with the earlier updated_at as SUPERSEDED. This rule is strict: never supersede the bullet with the later updated_at, regardless of which fact appears more stable or established.
- If updated_at is identical, mark the lower-confidence one as SUPERSEDED.
- Two bullets are NOT contradictions if they cover different time periods, describe different aspects of the same topic, or are additive (multiple skills, past events, preferences, etc.).

For each numbered bullet, output exactly one line:
N: KEEP
or
N: SUPERSEDED — brief reason

Output only these lines, one per bullet, nothing else.`;

export const semanticReviewPrompt = `Today is {TODAY}. Review these short-term (Working) memory bullets and identify which are stale, completed, or superseded.

{FILE_SUMMARIES_SECTION}{LONG_TERM_SECTION}Working bullets to review:
{NUMBERED_BULLETS}

For each numbered bullet, output exactly one line in the format:
N: KEEP
or
N: SUPERSEDED — brief reason

Output only these lines, one per bullet, nothing else.`;

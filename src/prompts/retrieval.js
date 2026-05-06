/**
 * Prompt set for memory retrieval and augmented query crafting.
 *
 * buildRetrievalPrompt()              — base retrieval prompt.
 * buildAdaptiveRetrievalPrompt(level) — multi-turn retrieval prompt tuned to prior confidence.
 * retrievalPrompt / adaptiveRetrievalPrompt — backward-compat aliases.
 * augmentAddendum                     — appended when crafting an augmented prompt.
 * augmentCrafterPrompt                — second-pass LLM prompt for privacy-minimized prompts.
 */

// ─── Shared sections ──────────────────────────────────────────────────────────

const RETRIEVAL_PREAMBLE_BASE = `You are a memory retrieval assistant. Your job is to find and assemble relevant personal context from the user's memory files to help answer their query.

You have access to a memory filesystem. The index below shows all available files:

\`\`\`
{INDEX}
\`\`\`

Instructions:
1. Look at the index above. If you can already see relevant file paths, use read_file directly to read them.
2. Use retrieve_file only when you need to search by keyword (e.g. "cooking", "Stanford") — it searches file contents, not paths.
3. Use list_directory to see ALL files in a directory when the query relates to a broad domain (e.g. list "health" for any medicine/health query).
4. Read at most {MAX_FILES} files.`;

const RETRIEVAL_TERMINAL_ASSEMBLE = `5. You MUST always finish by calling assemble_context — write a direct, synthesized answer in plain prose based on what you read. Do NOT paste raw bullet lists or file content. If the query is historical or comparative, reason over the facts and answer accordingly.
6. If nothing is relevant, call assemble_context with an empty facts array.`;

const RETRIEVAL_PREAMBLE = `${RETRIEVAL_PREAMBLE_BASE}\n${RETRIEVAL_TERMINAL_ASSEMBLE}`;

const DOMAIN_EXHAUSTIVE = `IMPORTANT — Domain-exhaustive retrieval:
- When a query touches a domain (health, work, personal), prefer completeness over selectivity within that domain. File descriptions may be incomplete.
- For family-related queries: check personal/family.md AND any health files about family members.`;

const IMPLIED_CONTEXT = `IMPORTANT — Implied context: Many queries depend on unstated personal facts. Before reading files, ask yourself: "What personal background would a human assistant need to answer this well?" Then search for that too.
Examples of implied needs:
- Travel / flight / driving queries → user's home city or current location (search personal files for location, city, where they live)
- Budget or cost questions → user's financial situation or income level
- Restaurant or activity recommendations → user's dietary restrictions, preferences, or neighborhood
- "Should I bring a jacket?" or weather questions → user's current location
- Scheduling or timing questions → user's timezone or work schedule
If the query implies a needed personal fact that isn't in the index path names, use retrieve_file to search for it (e.g. retrieve_file("location"), retrieve_file("city"), retrieve_file("home")).

Queries that often need implied context even when not stated explicitly:
- price, cost, fare, budget, affordability, "how much" → location, region, travel origin, household size, or financial context
- travel time, commute time, distance, "how long", "closest", logistics → current location, home city, usual transport mode
- suitability questions like "is this worth it", "should I go", "is it far", "is it expensive" → preferences, budget, location, schedule, or current commitments

If a likely implied fact is missing or ambiguous, do NOT immediately give up. First retrieve the relevant memory files that could contain that fact. If memory contains conflicting candidates (for example an older city and a newer city), mention the ambiguity in the assembled answer rather than pretending memory is irrelevant.

Minimal implied-context retrieval rules:
- If the query is missing a user-specific variable that would materially change the answer, do at least one targeted retrieval attempt for that variable before returning no context.
- Retrieve the fewest files needed to resolve the missing parameter.
- Prefer one likely file over listing or reading a whole directory.
- Do not broaden from the missing variable to adjacent biography unless it clearly changes the answer.
- If one retrieved file already gives the needed context, stop and answer.
- Only expand to a second or third file if the first result is missing, ambiguous, or contradictory.
- For implied-context retrieval, favor narrow searches like location, timezone, budget, dietary preference, or schedule over broad domain sweeps.
- Do not treat "minimal" as "skip retrieval entirely." Minimal means one or two highly targeted reads, not zero reads.`;

const CONVERSATION_NOTE = `When recent conversation context is provided alongside the query, use it to resolve references like "that", "the same", "what we discussed", etc. The conversation shows what the user has been talking about recently.

Only include content that genuinely helps answer this specific query. Do not include unrelated files from other domains.`;

// ─── Retrieval guidance ────────────────────────────────────────────────────────

const RETRIEVAL_NOOP = `CONSERVATIVE DEFAULT — lean toward no-op:
- Before opening any file, ask: "Would including personal memory give a meaningfully better answer to this specific query?" If not clearly yes, call assemble_context with an empty facts array immediately — no file reads needed.
- Statements of current activity ("I'm studying X", "I started learning Y") do NOT need memory retrieval unless the user also asks a specific question that depends on personal context.
- Pure general knowledge questions and topic explanations rarely benefit from personal memory.
- If the only files you would read are loosely topical (same domain as the query, but the facts inside wouldn't change the answer), skip them.
- Sparse or thin memory files do not raise answer quality — do not retrieve them.
- RETRIEVE for queries about the user's own habits, routines, behaviors, decisions, or plans — even if phrased as "how do I" or "help me". Personal context materially changes the answer for these. Examples: "help me be more productive", "should I go full-time", "what should I eat", "how should I train".
- IMPORTANT exception: If the query is underspecified and a personal fact would resolve a missing parameter, ambiguity, or decision variable, retrieve that specific fact before deciding to skip. Even then, stay minimal.`;

const RETRIEVAL_ASSEMBLY = `CONFIDENCE-AWARE ASSEMBLY:
- Only include facts that directly answer the query. Do not volunteer adjacent context from the same file unless it materially changes the answer.
- Return each relevant fact as a separate item in the facts array. Process each bullet individually:
  - confidence >= 0.8 bullet → pass the numeric value through, written as a direct statement ("You completed X", "You work on Y").
  - confidence < 0.8 bullet (intentions, plans, habits, tendencies) → pass the numeric value through, written already hedged ("You've mentioned wanting to...", "You tend to...", "You're currently considering...").
  - source=inference, llm_infer, or assistant_summary → use confidence=0.3 regardless of the bullet's confidence field, written hedged.
- Write each fact as one complete sentence. Do not merge bullets of different confidence levels into the same sentence.
- If nothing relevant was found, return an empty facts array.`;

/**
 * Build the base retrieval prompt.
 * The returned string still contains {INDEX} and {MAX_FILES} placeholders.
 *
 * @param {{ includeAssembly?: boolean }} [options]
 * @returns {string}
 */
export function buildRetrievalPrompt(_level = 'unknown', { includeAssembly = true } = {}) {
    // In augment mode: use the base preamble (no "call assemble_context" steps 5-6)
    // and rewrite NOOP skip instructions to reference augment_query instead.
    // The AUGMENT_SYSTEM_ADDENDUM appended by the caller provides the definitive terminal instruction.
    const preamble = includeAssembly ? RETRIEVAL_PREAMBLE : RETRIEVAL_PREAMBLE_BASE;
    const effectiveNoop = includeAssembly
        ? RETRIEVAL_NOOP
        : RETRIEVAL_NOOP
            .replace(/call assemble_context with an empty (?:string|facts array)(?: immediately)?/g,
                'call augment_query with an empty memory_files array');
    const sections = [
        preamble,
        effectiveNoop,
        DOMAIN_EXHAUSTIVE,
        IMPLIED_CONTEXT,
        CONVERSATION_NOTE,
    ];
    if (includeAssembly) sections.push(RETRIEVAL_ASSEMBLY);
    return sections.join('\n\n');
}

// ─── Builder: adaptive (multi-turn) retrieval ─────────────────────────────────

const ADAPTIVE_PREAMBLE = `You are a memory retrieval assistant operating in a multi-turn session.

You have access to a memory filesystem. The index below shows all available files:

\`\`\`
{INDEX}
\`\`\`

The following memory context was already retrieved and delivered earlier in this session:

\`\`\`
{ALREADY_RETRIEVED}
\`\`\`

Instructions:
1. First assess whether the current query is already sufficiently covered by the already-retrieved context above.
2. If it IS covered — call assemble_context with an empty facts array, skipped=true, and a brief skip_reason. Do not use any retrieval tools.
3. If it is NOT covered or only partially covered — use the retrieval tools to find only the MISSING information. Read at most {MAX_FILES} files.
4. Once you have retrieved new information, call assemble_context with ONLY the newly found facts in the facts array. Do not repeat what was already retrieved. Leave skipped unset (or false).
5. If you searched but found nothing new, call assemble_context with an empty facts array and skipped=true, skip_reason="No new relevant memory found."`;

const ADAPTIVE_SKIP_HIGH = `Skip aggressiveness — HIGH (prior context is reliable):
- The previously retrieved context is high-confidence. If it covers the current query even partially, prefer skipped=true.
- Only retrieve new information if the current query introduces a genuinely new personal variable not present in the prior context.
- When in doubt, skip — the prior context can be trusted.`;

const ADAPTIVE_SKIP_MEDIUM = `Skip aggressiveness — MEDIUM (prior context is mixed):
- The previously retrieved context has mixed confidence. Only skip if the prior context clearly and directly answers the current query with high-confidence facts.
- If the prior context only partially or tangentially covers the query, attempt a targeted retrieval for the missing piece.
- Do not skip just because the topic is similar — check whether the specific question is answered.`;

const ADAPTIVE_SKIP_LOW = `Skip aggressiveness — LOW (prior context is uncertain):
- The previously retrieved context has low confidence or may be unreliable. Do not skip unless the current query is fully answered by high-confidence facts already retrieved.
- When in doubt, attempt retrieval — re-checking is better than relying on uncertain prior context.
- Re-retrieve if the current query could resolve ambiguities in the prior context.`;

const ADAPTIVE_CONSERVATIVE = `Conservative default: Before retrieving anything new, ask "Would personal memory give a meaningfully better answer to this specific query?" If not clearly yes, call assemble_context with an empty string and skipped=true. Statements of current activity and general knowledge almost never need retrieval. Exception: if the query is underspecified and personal memory would supply a missing parameter, retrieve that context narrowly before skipping.`;

const ADAPTIVE_IMPLIED = `Implied context: When a query does warrant retrieval, consider what unstated personal facts it depends on. Travel/flight queries need the user's home city; cost questions may need financial context; recommendations need location or preferences. More generally, "how much", "how long", "is it worth it", "closest", and similar queries often depend on user-specific context not stated explicitly. Retrieve those implied facts if they are missing from already-retrieved context.`;

const ADAPTIVE_CONVERSATION_NOTE = `When recent conversation is provided alongside the query, use it to resolve references like "that", "the same", "what we discussed", etc.

Only retrieve content that genuinely adds to what is already in the session context.`;

/**
 * Build an adaptive retrieval prompt tuned to prior confidence.
 * The returned string still contains {INDEX}, {ALREADY_RETRIEVED}, and {MAX_FILES} placeholders.
 *
 * @param {'high' | 'medium' | 'low' | 'none' | 'unknown'} [previousConfidence] - confidence of the previous turn (controls skip aggressiveness)
 * @returns {string}
 */
export function buildAdaptiveRetrievalPrompt(previousConfidence = 'unknown') {
    let skipSection;
    if (previousConfidence === 'high') skipSection = ADAPTIVE_SKIP_HIGH;
    else if (previousConfidence === 'low' || previousConfidence === 'none') skipSection = ADAPTIVE_SKIP_LOW;
    else skipSection = ADAPTIVE_SKIP_MEDIUM;

    return [
        ADAPTIVE_PREAMBLE,
        skipSection,
        ADAPTIVE_CONSERVATIVE,
        ADAPTIVE_IMPLIED,
        ADAPTIVE_CONVERSATION_NOTE,
        RETRIEVAL_ASSEMBLY,
    ].join('\n\n');
}

// ─── Backward-compat aliases ──────────────────────────────────────────────────

export const retrievalPrompt = buildRetrievalPrompt('unknown');
export const adaptiveRetrievalPrompt = buildAdaptiveRetrievalPrompt('unknown');

// ─── Augment prompts ──────────────────────────────────────────────────────────

export const augmentAddendum = `

## Augment Query

After reading memory files, you MUST call augment_query with the original user query plus the minimal relevant memory file paths. Do NOT draft the final prompt in the tool arguments. The augment_query tool itself will run the prompt-crafting pass.

Rules:
- Read the relevant files first so you know which paths matter.
- Set user_query to the original user message verbatim.
- Pass only the minimum set of memory file paths needed for a high-quality answer.
- Do not include any facts, summaries, names, or rewritten instructions in the tool arguments.
- If a file does not materially improve the final answer, leave it out.
- If a file only confirms a general interest already obvious from the query, leave it out.
- If nothing relevant is found, call augment_query with an empty memory_files array.
- Make exactly one augment_query call for this user message.
- Do NOT call assemble_context in this mode.
`;

export const augmentCrafterPrompt = `You craft prompts that a user sends to a frontier AI model.

Your job: take the user's request and any relevant memory, then produce a single natural, first-person prompt that reads exactly like something a thoughtful person would type themselves.

Return JSON only:
{"reviewPrompt":"string"}

## Core rules

- The frontier model has zero prior context. Include everything it actually needs in one pass.
- Include only the minimum user-specific data required to answer well.
- If memory is not actually needed, keep the prompt generic.
- Keep the user's current request in normal prose.
- Every additional fact sourced from memory files or recent conversation that you include must be wrapped in either [[user_data]]...[[/user_data]] or [[user_data_uncertain]]...[[/user_data_uncertain]].
- Do not wrap generic instructions, output-format guidance, or your own reasoning in tags.
- Put everything into one final minimized prompt in reviewPrompt.
- Do not include markdown fences or any text outside the JSON object.

## Voice and format

- Write entirely in first person ("I", "my", "I've been thinking about...").
- Keep the user's original request as plain prose at the start.
- No section labels, headers, or structural markers of any kind.
- The final prompt must read like a coherent message a human would actually send.

## Tag structure — one tag type per confidence tier

- High-confidence facts → wrap in [[user_data]]...[[/user_data]]
- Medium-confidence facts → wrap in [[user_data_uncertain]]...[[/user_data_uncertain]]
- If no memory is needed, omit all tags entirely.
- Do NOT merge high and medium facts into one block.
- Do NOT use "they" or "the user" — always first person.
- Do NOT omit high-confidence behavioral facts (habits, patterns, tendencies) — these are the most useful context for behavior-related queries.

## Confidence through word choice

- confidence >= 0.8 → state directly as a current fact inside [[user_data]]: "I do my best work before noon." / "I'll be in Kyoto in October 2026."
- confidence < 0.8 → state inside [[user_data_uncertain]] as a fact that may not be accurate. Prefix with "I think" or "I believe": "I think I block my mornings — no Slack until noon." The tag itself signals uncertainty; keep the prose natural.
- confidence <= 0.3 or source=inference → omit unless no alternative.

## What to include

- Match facts to the query's specific topic, not just the file they came from. A file about work may contain career decisions AND productivity habits — for a productivity query, include the habit facts, not the career deliberations.
- Include ALL high-confidence facts that are directly relevant. Do not stop at one. If three high-confidence facts are relevant, include all three in the first block.
- Dietary constraints, confirmed plans, concrete specs, behavioral patterns → include if relevant.
- Vague interests, background biography, domain overlap alone → omit.
- If the query is self-contained and memory adds nothing, return the request verbatim with no [[user_data]] block.

## Privacy

- Every included fact should pass this test: "Does the frontier model need this specific fact to answer well?" If no, leave it out.
- If a memory fact only repeats or confirms what the current query already makes obvious, leave it out.
- No real names unless the task genuinely requires them.
- No location unless it changes the answer.
- Generalize where possible: "my partner is vegetarian" not a name.

## Examples

Query: "plan a romantic evening in Kyoto"
Memory: traveling Oct 2026 (high), pescatarian (high), anniversary plan (medium)
Output: Plan a romantic evening in Kyoto. [[user_data]]I'll be there in October 2026 with my partner — we're both mostly pescatarian.[[/user_data]] [[user_data_uncertain]]I think we also talked about celebrating our anniversary in Kyoto.[[/user_data_uncertain]]

Query: "help me be more productive at work"
Memory: does best work before noon (high), checks HN as procrastination (high), considering morning blocking (medium), tried it inconsistently (medium)
Output: Help me be more productive at work. [[user_data]]I do my best technical work before noon and tend to drift to easier tasks in the afternoon. I also check Hacker News more than I should — it's usually procrastination, not staying informed.[[/user_data]] [[user_data_uncertain]]I think I block my mornings strictly — no Slack or email until noon — though I've been inconsistent about it.[[/user_data_uncertain]]

Query: "help me think through going full-time on my startup"
Memory: Mise startup exists (high), 9mo runway (high), leaning toward Q1 2027 (medium)
Output: Help me think through going full-time on my startup. [[user_data]]I've been building a recipe side project with about 9 months of runway if I leave my job.[[/user_data]] [[user_data_uncertain]]I think I'm leaning toward trying it full-time in early 2027 if the trajectory holds.[[/user_data_uncertain]]

Query: "how do I fix this Python bug" (self-contained code question)
Memory: various unrelated facts
Output: how do I fix this Python bug

The user will review the exact prompt before it is sent. Keep it natural, minimal, and honest about uncertainty.`;

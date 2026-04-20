/**
 * Prompt set for document ingestion.
 *
 * ingestionPrompt  — general import: full discretion over create/append/update.
 * addPrompt        — `nanomem add --format markdown`: only write NEW facts (create or append, no updates).
 * updatePrompt     — `nanomem update --format markdown`: only edit EXISTING facts (no new files).
 */

export const addPrompt = `You are a memory manager. Extract NEW facts from the document that do not yet exist in memory.

You may extract and reasonably infer facts from what the document shows — not just word-for-word statements. Use good judgment: extract what is clearly supported by the content, avoid speculation.

Current memory index:
\`\`\`
{INDEX}
\`\`\`

For each new fact, decide:
- Use append_memory if an existing file already covers the same domain or topic.
- Use create_new_file only if no existing file is thematically close.

Do NOT save:
- Facts already present in memory
- Boilerplate (installation steps, license text, generic disclaimers)
- Sensitive secrets (passwords, tokens, keys)

Bullet format: "- Fact text | topic=topic-name | source=document | confidence=high | updated_at=YYYY-MM-DDTHH:MM"
For time-bound facts (temporary plans, short-term goals, events with a clear end date), append: | expires_at=YYYY-MM-DD

If nothing new is worth saving, stop without calling any tools.`;

export const updatePrompt = `You are a memory manager. Correct or update facts already saved in memory based on the document below.

CRITICAL: Only edit files that already exist. Do NOT create new files. Do NOT rewrite whole files.

Current memory index:
\`\`\`
{INDEX}
\`\`\`

Steps:
1. Identify which existing file(s) hold facts that are now stale or contradicted by the document.
2. Use read_file to read the current content and find the exact bullet text to replace.
3. Use update_bullets with all corrections for that file in a single call, passing the exact old fact text and the corrected fact text for each.

Rules:
- Only change bullets that are directly contradicted or corrected by the new information.
- Do not touch any other bullets in the file.
- Pass old_fact exactly as it appears in the file (including pipe-delimited metadata is fine).
- Pass new_fact as plain text only — no metadata.

If nothing needs updating, stop without calling any tools.`;

export const ingestionPrompt = `You are a memory manager. You are reading documents (notes, README files, code repositories, articles) and extracting facts about the subject into a structured memory bank.

Unlike conversation ingestion, you may extract and reasonably infer facts from what the documents show — not just what was explicitly stated word-for-word. Use good judgment: extract what is clearly supported by the content, avoid speculation.

Save information that would be useful when answering questions about this subject in the future. Be generous — capture expertise, projects, preferences, philosophy, and patterns that emerge from the documents.

Do NOT save:
- Speculation or guesses not supported by the content
- Boilerplate (installation steps, license text, generic disclaimers)
- Information already present in existing files
- Sensitive secrets (passwords, auth tokens, private keys)

Current memory index:
\`\`\`
{INDEX}
\`\`\`

**Key principle: Create a NEW file for each distinct topic.** Organize into domain folders (e.g. projects/, expertise/, education/, philosophy/) with topic-specific files within them.

Instructions:
1. Read the document content and identify concrete, reusable facts about the subject.
2. Do not read files before writing. The memory index is sufficient to decide where to append or create. Only read a file if the index entry is ambiguous and you need the exact current content to avoid duplicating a fact.
3. Use create_new_file for new topics, append_memory to add to existing files.
4. Use this bullet format: "- Fact text | topic=topic-name | source=SOURCE | confidence=LEVEL | updated_at=YYYY-MM-DDTHH:MM"
5. Source values (IMPORTANT — never use source=user_statement here):
   - source=document — the fact is directly stated or clearly shown in the document. Use for the majority of facts.
   - source=document_infer — a reasonable inference from what multiple parts of the document collectively show (e.g. a repo with only C files and a README praising simplicity → "prefers low-level, minimal implementations"). Use sparingly.
6. Confidence: high for source=document facts, medium for source=document_infer.
7. Facts worth extracting: skills and expertise, projects built, stated opinions and philosophy, tools and languages used, patterns across work, goals and motivations, background and experience.
8. If nothing meaningful can be extracted from a document, stop without calling any write tools.

Rules:
- Write facts in a timeless, archival format: use absolute dates (YYYY-MM-DD) rather than relative terms like "recently", "currently", "just", or "last week". A fact must be interpretable correctly even years after it was written.
- One file per distinct topic. Do NOT put unrelated facts in the same file.
- Create new files freely — focused files are better than bloated ones.
- Content should be raw facts only — no filler commentary.`;

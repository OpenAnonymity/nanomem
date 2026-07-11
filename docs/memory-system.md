# Memory System Internals

This document gives a high-level view of how `@openanonymity/nanomem` works internally. For installation and usage, see the [README](../README.md).

## Core Idea

The system is built around two ideas:

- memory should stay user-visible and portable
- memory should be maintained as evolving state, not just retrieved as static context

That means the system is designed to do more than store history and search it later. It tries to keep memory current, compact, and historically aware while still storing it as a plain markdown memory filesystem.

## Three Core Flows

The architecture has three main flows:

- **Ingestion** turns conversations or documents into structured memory
- **Retrieval** assembles relevant memory for a query
- **Compaction** keeps memory coherent over time

These three flows are the core of the system.

## Prompt Modes

Ingestion supports two high-level modes:

- **Conversation mode** for chats and transcripts
- **Document mode** for notes, READMEs, repositories, and knowledge bases

In practice:

- conversation-like inputs use stricter extraction
- document-like inputs use broader extraction

The CLI selects these modes automatically in common cases, while still allowing explicit control when needed.

## Ingestion

Ingestion is the write path.

The system runs ingestion as an agentic tool loop over a conversation or document. The ingestion agent sees the current file tree and can:

- call `read_file` before changing existing memory
- call `create_new_file` when no existing file fits
- call `append_memory` for genuinely new facts in an existing topic
- call `update_bullets` to supersede stale or contradicted bullets
- call `corroborate_bullet` when new input reconfirms an existing fact

The exact tool set depends on mode: `add` only writes new or corroborated facts, while default/update-style ingestion can supersede existing bullets when the prompt permits it.

The tool executors normalize generated bullets, merge them into the markdown file, refresh the bullet index, and preserve history when facts are superseded. The goal is to turn raw input into reusable memory rather than keeping every interaction forever.

## Retrieval

Retrieval is the read path.

The system runs retrieval as an agentic tool loop over the memory filesystem. The agent sees the file tree and can:

- inspect the file tree for likely paths
- call `search_memory` for targeted keyword search
- call `list_directory` for broad directory scans
- call `read_file` for broader file-level context
- finish with `assemble_context`, which returns synthesized context plus sufficiency metadata

`search_memory` returns matching file paths and matching raw lines from each file. Because memory is stored as structured markdown bullets, those matches are often enough for targeted queries; `read_file` is used when surrounding file context is needed.

This is intentionally more structured than plain keyword search or vector retrieval alone:

- the visible file tree gives the agent a stable map of user-owned memory
- backend keyword search can jump directly to relevant matching lines
- selective file reads provide surrounding context only when needed
- recent conversation context can help resolve references like “that” or “the same one”

If the model-based retrieval path fails, the system falls back to deterministic keyword search, loads the top matching files, and builds query-aware excerpts instead of dumping entire files. Adaptive fallback folds recent conversation into the search query so referential follow-ups can still resolve without network access.

## Compaction

Compaction is the maintenance path.

Unlike ingestion and retrieval, compaction is not an agentic tool loop. It walks stored files and applies a maintenance pipeline:

- deterministic compaction parses bullets, deduplicates, assigns tiers, and archives expired facts
- semantic review asks the LLM to mark stale working-memory bullets as superseded
- contradiction review asks the LLM to resolve active bullets that cannot both be current
- legacy unstructured files can be rewritten into the canonical tiered format

`prune`/`pruneExpired` is the deterministic no-LLM path that only archives facts whose `expires_at` date has passed.

History distinguishes two ways a fact leaves current memory. A fact that a newer, contradicting fact **supersedes** is dropped from answers. A fact that simply **expires** (its `expires_at` date passes without anything contradicting it) stays on record and remains answerable for recall, ranked below active facts rather than presented as the current state.

This is what lets the system maintain memory over time instead of just accumulating more text.

## The Memory Model

Memory is stored as markdown with structured metadata attached to each fact.

At a high level, the model tracks:

- **topic**: what domain a fact belongs to
- **tier**: whether it is working memory, long-term memory, or history
- **status**: whether it is active, superseded, expired, or uncertain
- **source and confidence**: where the fact came from and how much to trust it
- **time information**: when it was updated and whether it should be reviewed or expire

This structure is what makes the system time-aware and conflict-aware.

## The Two Indexes

The system keeps two indexes:

- a **persistent file tree** that gives the model and tools a stable map of the memory filesystem
- an **in-memory fact index** that supports scoring and excerpt selection at bullet granularity

They exist because filesystem navigation, keyword recall, and fact ranking are different problems at different levels of granularity. The tree helps the retrieval agent choose where to look; backend search provides file-and-line recall; and the bullet index supports compact, query-aware snippets.

## Conflict Resolution

Conflict handling is split across the system:

- ingestion helps decide how new information should update existing memory
- compaction helps clean up duplicates, stale facts, and superseded entries

In practice, this allows the system to:

- keep repeated facts from piling up
- distinguish current facts from historical ones
- preserve history without mixing it into active context
- handle contradictions more deliberately than an append-only log

## Storage Model

The same memory model can run across multiple backends, including local files, browser persistence, and ephemeral in-memory storage.

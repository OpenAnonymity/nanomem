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

The system reads a conversation or document, looks at the current file tree, and decides whether to:

- create a new memory file
- append to an existing one
- update a stale one
- archive outdated information
- delete memory that is no longer useful

The goal is to turn raw input into reusable memory rather than keeping every interaction forever.

## Retrieval

Retrieval is the read path.

The system first uses the file tree to decide which memory files matter for a query. It then looks more closely at the facts inside those files and assembles relevant context.

This is intentionally more structured than plain keyword search or vector retrieval alone:

- file-level selection narrows the search space
- fact-level scoring surfaces the most useful memory
- recent conversation context can help resolve references like “that” or “the same one”

If the model-based retrieval path fails, the system can fall back to simpler search over stored files.

## Compaction

Compaction is the maintenance path.

Its job is to keep memory useful as it grows:

- merge duplicates
- keep current memory concise
- move stale or superseded facts into history
- preserve older information without treating it as current

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

- a **persistent file tree** that helps the model navigate the memory filesystem
- an **in-memory fact index** that helps retrieval score individual facts after files are selected

They exist because file selection and fact ranking are different problems at different levels of granularity.

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

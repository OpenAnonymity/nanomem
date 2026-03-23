# Memory System Documentation

This document explains how the `@openanonymity/memory` repository works as a whole.

## Overview

`@openanonymity/memory` is an LLM-driven personal memory system built around a markdown-backed virtual filesystem.

The system has three main jobs:

1. Extract reusable facts from conversations into memory files.
2. Retrieve relevant memory context for a new query.
3. Compact and normalize stored memory over time.

The central design choice is that memory is stored as ordinary markdown documents with metadata-rich bullets, rather than hidden vector-only state or a proprietary database schema.

## Core Architecture

The public entry point is `createMemory()` in `src/index.js`.

It wires together:

- an LLM client
- a storage backend
- a bullet index
- the retrieval module
- the extraction module
- the compactor

At runtime, the system looks like this:

```text
Conversation / Query
        |
        v
  Retrieval or Extraction
        |
        v
  Tool-calling loop
        |
        v
  Storage backend <-> markdown files
        |
        v
   Bullet parsing / compaction / indexing
```

## Main Modules

### `src/index.js`

This is the factory and public API surface.

It exposes:

- `init()`
- `retrieve(query, options)`
- `extract(messages, options)`
- `compact()`
- `maybeCompact()`
- direct storage helpers like `read`, `write`, `search`, `ls`, `delete`, `exportAll`

It also selects the storage backend and LLM client implementation.

### `src/core/extractor.js`

The extractor is the write path.

It takes a conversation, gives the model a constrained tool set, and asks it to decide whether anything should be saved. The model can:

- read an existing file
- create a new file
- append to a file
- update a file
- archive an item
- delete a file

Generated content is normalized through the bullet utilities before being written, so extracted memory follows the repo’s canonical format.

### `src/core/retrieval.js`

The retrieval module is the read path.

It uses a tool-calling loop to let the model inspect the memory index, search files, read specific files, and assemble final context for the current query.

Important behavior:

- retrieval can use recent conversation context to resolve references like `that` or `the same`
- there is a quick path for some common domains
- there is a non-LLM fallback using text search if the model call fails
- retrieval returns curated memory context rather than the full database

### `src/core/compactor.js`

The compactor consolidates memory files into stable `Working`, `Long-Term`, and `History` sections.

It is responsible for:

- deduplication
- moving expired or stale items into history
- conflict resolution
- keeping files readable and bounded

If a file already parses as structured memory bullets, the system prefers deterministic local compaction. If it cannot parse the file structure, it can fall back to LLM rewriting.

### `src/bullets/utils.js`

This file is the heart of the local memory format.

It handles:

- bullet parsing
- metadata normalization
- rendering bullets back to markdown
- topic normalization
- scoring bullets for retrieval
- local compaction rules
- conflict resolution

This module is where the canonical bullet schema lives.

### `src/bullets/bulletIndex.js`

The bullet index is a lightweight in-memory index over parsed bullets.

It is used mainly to:

- speed up snippet-based retrieval
- avoid reparsing everything for every request
- support quick relevance scoring

The index is refreshed per path after writes and can be fully rebuilt.

### `src/storage/*`

The storage layer abstracts where markdown memory files live.

Current implementations:

- `src/storage/memory.js`: in-memory storage for tests and ephemeral use
- `src/storage/filesystem.js`: real `.md` files on disk in Node.js
- `src/storage/indexeddb.js`: browser persistence via IndexedDB
- `src/storage/interface.js`: tool executors used by retrieval and extraction

All storage backends share the same logical model and expose the same interface.

### `src/schema/memorySchema.js`

This defines the memory filesystem structure and bootstrap behavior.

It provides:

- namespace guidance like `personal/`, `health/`, `work/`, `preferences/`
- index rendering
- default seed files
- extractor taxonomy guidance

## Data Model

Memory is stored as markdown bullet points with metadata.

Example:

```md
- Takes thyroid medication daily | topic=health | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2026-03-22
```

Important metadata fields:

- `topic`: normalized topic namespace
- `tier`: `working`, `long_term`, or `history`
- `status`: `active`, `superseded`, `expired`, or `uncertain`
- `source`: `user_statement`, `assistant_summary`, `inference`, or `system`
- `confidence`: `high`, `medium`, or `low`
- `updated_at`
- optional `review_at`
- optional `expires_at`

## File Layout

Each memory file is expected to converge toward this structure:

```md
# Memory: Topic

## Working
### Current context
- ...

## Long-Term
### Stable facts
- ...

## History
### No longer current
- ...
```

The repo also maintains `_index.md`, which acts as the top-level file index for retrieval.

## End-to-End Flows

### 1. Extraction flow

1. The app calls `memory.extract(messages)`.
2. The extractor builds a system prompt with the current index and filesystem taxonomy.
3. The LLM runs in a tool loop and decides whether to create or modify files.
4. Storage executors normalize generated bullet content.
5. The bullet index is refreshed after writes.

### 2. Retrieval flow

1. The app calls `memory.retrieve(query, options)`.
2. The retriever loads `_index.md`.
3. It may take a quick local path for common domains.
4. Otherwise the LLM selects files through tool calls.
5. The retriever assembles a concise memory context payload.
6. If the LLM path fails, retrieval falls back to text search.

### 3. Compaction flow

1. The app calls `memory.compact()` or `memory.maybeCompact()`.
2. All real memory files are loaded.
3. Structured files are compacted locally.
4. Legacy or malformed files can be rewritten with the LLM.
5. Updated files are written back and reindexed.

## Conflict Resolution

Conflict resolution is built into bullet compaction.

Current policy:

- newer explicit user statements supersede older explicit user statements
- user statements beat inferences
- conflicting inferred facts prefer newer or higher-confidence versions
- ambiguous conflicts keep both, with the weaker one marked `uncertain`

See `docs/conflict-resolution.md` for details.

## Storage Interface

Every backend implements the same contract:

```text
init()                -> void
read(path)            -> string | null
write(path, content)  -> void
delete(path)          -> void
exists(path)          -> boolean
ls(dirPath)           -> { files: string[], dirs: string[] }
search(query)         -> [{ path, snippet }]
getIndex()            -> string
rebuildIndex()        -> void
exportAll()           -> [{ path, content, updatedAt, itemCount, l0 }]
```

This lets the same retrieval and extraction logic run unchanged across browser, Node.js, and in-memory environments.

## LLM Integration Model

The repo uses tool-calling rather than asking the model for a full memory dump or full-memory rewrite on every interaction.

That means:

- the model makes bounded decisions through explicit tools
- storage remains inspectable and editable as markdown
- local deterministic logic can handle normalization and compaction
- failures can fall back to simpler logic

LLM providers are abstracted behind `createChatCompletion()` style clients.

Supported paths today:

- OpenAI-compatible APIs
- Anthropic
- custom clients

## Design Principles

The codebase is built around a few consistent principles:

- markdown-first storage
- topic-scoped files instead of one giant profile blob
- tool-mediated LLM actions
- deterministic local post-processing where possible
- graceful fallback behavior
- durable separation of current facts and historical facts

## Extension Points

Common ways to extend the system:

- add a new storage backend implementing the standard interface
- improve conflict classification in `src/bullets/utils.js`
- add richer retrieval heuristics in `src/core/retrieval.js`
- expand filesystem taxonomy in `src/schema/memorySchema.js`
- plug in another LLM provider through the same client contract

## Current Limitations

- conflict detection is heuristic rather than full semantic contradiction detection
- retrieval quality still depends on the model choosing the right files
- search is text-based, not embedding-based
- compaction can only be as clean as the underlying bullet structure allows
- there is not yet a separate formal schema versioning or migration layer

## Recommended Reading Order

If you are new to the repo, read files in this order:

1. `src/index.js`
2. `src/core/extractor.js`
3. `src/core/retrieval.js`
4. `src/core/compactor.js`
5. `src/bullets/utils.js`
6. `src/storage/interface.js`
7. `src/schema/memorySchema.js`

That sequence gives the cleanest view from public API down to data model and storage details.

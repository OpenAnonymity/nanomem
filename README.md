# @openanonymity/nanomem

**Personal memory you own, in files you can actually read.**

`nanomem` turns chats, notes, and exports into a markdown memory system that an LLM can update and retrieve as facts evolve over time. The result stays inspectable, portable, and user-owned instead of disappearing into hidden vector state.

## Why it exists

`nanomem` is for building memory that can last beyond a single chat session, model, or tool.

It turns raw conversations, notes, and exports into a memory system that can:

- compress repeated interactions into stable knowledge
- keep up with changing facts over time
- preserve history without cluttering current context
- stay inspectable and user-controlled

Retrieval is only one part of memory. `nanomem` is built for the maintenance layer too: updating facts, resolving conflicts, and preserving history over time.

## Features

- **User-owned memory.** Keep memory in markdown files you can inspect, edit, version, and move across tools.
- **Evolving memory state.** Keep facts current as they change over time instead of treating memory as an append-only log.
- **Compaction and cleanup.** Collapse repeated signals into stable knowledge and move stale memory into history.
- **Conflict-aware updates.** Resolve outdated or contradictory facts using recency, source, and confidence.
- **Import your existing history.** Start from ChatGPT exports, [OA Chat](https://chat.openanonymity.ai) exports, transcripts, message arrays, markdown notes, or whole markdown directories.
- **Flexible storage.** Run on local files, IndexedDB, in-memory storage, or a custom backend.
- **Built to plug in.** Use it from the CLI, as a library, or as a memory layer for other agents.

## Quick start

Install:

```bash
npm i @openanonymity/nanomem
```

Set up once:

```bash
nanomem login
```

This walks you through provider, model, API key, and where to store your memory. Config is saved to `~/.config/nanomem/config.json`. Filesystem memory lives in `~/nanomem/` by default.

Add facts directly:

```bash
nanomem add "I moved to Seattle and started a new job at Acme."
nanomem update "Actually I moved to Portland, not Seattle."
```

Import history or notes:

```bash
nanomem import conversations.json
nanomem import my-notes.md
nanomem import ./notes/
```

Retrieve memory later:

```bash
nanomem retrieve "what are my hobbies?"
nanomem retrieve "what are my hobbies?" --render
```

Delete facts from memory:

```bash
nanomem delete "I have a dog named Mochi"
nanomem delete "I have a dog named Mochi" --deep
```

Compact and clean up memory:

```bash
nanomem compact
```

Scripted setup also works:

```bash
nanomem login --provider openai --api-key sk-... --model gpt-5.4-mini
nanomem login --provider anthropic --api-key sk-ant-... --model claude-sonnet-4-6 --path ~/project/memory
```

Supported providers include OpenAI, Anthropic, Tinfoil, OpenRouter, and OpenAI-compatible endpoints via `--base-url`.

## How it works

```text
conversation / notes / exports
            |
            v
      memory import / ingest
            |
            |  LLM extraction with tool calls
            |  create / append / update / archive / delete
            v
   markdown memory filesystem
            |
            |  memory retrieve
            |  file selection + bullet-level scoring
            v
      assembled memory context
            |
            v
       memory compact
       dedup + temporal cleanup + history preservation
```

The core engine has three parts:

- **Ingestion.** Extract durable facts from conversations or documents and organize them into topic files.
- **Retrieval.** Navigate the memory filesystem and assemble relevant context for a query.
- **Compaction.** Deduplicate repeated facts, keep current memory concise, and move stale or superseded facts into history.

## Memory format

Memory is stored as markdown with structured metadata:

```md
# Memory: Work

## Working
### Current context
- Preparing for a product launch next month | topic=work | tier=working | status=active | source=user_statement | confidence=high | updated_at=2026-04-07 | review_at=2026-04-20

## Long-Term
### Stable facts
- Leads the backend team at Acme | topic=work | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2026-04-07

## History
### No longer current
- Previously lived in New York | topic=personal | tier=history | status=superseded | source=user_statement | confidence=high | updated_at=2024-06-01
```

That structure is what lets the system do more than retrieval: it can keep track of source, confidence, recency, temporary context, and historical state.

## Using it in code

```js
import { createMemoryBank } from '@openanonymity/nanomem';

const memory = createMemoryBank({
  llm: { apiKey: 'sk-...', model: 'gpt-5.4-mini' },
  storage: 'filesystem',
  storagePath: './memory'
});

await memory.init();

await memory.ingest([
  { role: 'user', content: 'I just moved to Seattle.' },
  { role: 'assistant', content: 'Noted.' }
]);

const result = await memory.retrieve('Where do I live now?');
await memory.compact();
```

## Common commands

```bash
nanomem add <text>                           # add new facts
nanomem update <text>                        # correct existing facts
nanomem delete <query>                       # delete facts matching a query
nanomem delete <query> --deep                # delete across all files (thorough)
nanomem import <file|dir|->                  # import history or notes
nanomem retrieve <query> [--context <file>]  # retrieve relevant context
nanomem tree                                 # browse memory files
nanomem compact                              # deduplicate and archive
nanomem export --format zip                  # export everything
nanomem status                               # show config and stats
```

For terminal use, `--render` will format markdown-heavy output like `read` and `retrieve` into a more readable ANSI-rendered view while leaving `--json` and piped output unchanged.

## Import formats

`nanomem import` supports:

- ChatGPT exports
- [OA Chat](https://chat.openanonymity.ai) exports
- markdown notes
- recursive markdown directory imports
- JSON message arrays
- plain text `User:` / `Assistant:` transcripts

Import can operate in both conversation-oriented and document-oriented modes, depending on the source or explicit flags.

```bash
nanomem import conversations.json              # conversation mode
nanomem import ./notes/                        # document mode (auto for directories)
nanomem import my-notes.md --format markdown   # document mode (explicit)
```

## Storage backends

- `filesystem` for local markdown folders
- `indexeddb` for browser storage
- `ram` for testing or ephemeral usage
- custom backend objects for your own storage layer

## Learn more

Internals: [docs/memory-system.md](./docs/memory-system.md)

## License

MIT

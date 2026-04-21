# @openanonymity/nanomem

```
 __   __     ______     __   __     ______     __    __     ______     __    __
/\ "-.\ \   /\  __ \   /\ "-.\ \   /\  __ \   /\ "-./  \   /\  ___\   /\ "-./  \
\ \ \-.  \  \ \  __ \  \ \ \-.  \  \ \ \/\ \  \ \ \-./\ \  \ \  __\   \ \ \-./\ \
 \ \_\\"\_\  \ \_\ \_\  \ \_\\"\_\  \ \_____\  \ \_\ \ \_\  \ \_____\  \ \_\ \ \_\
  \/_/ \/_/   \/_/\/_/   \/_/ \/_/   \/_____/   \/_/  \/_/   \/_____/   \/_/  \/_/
```

**Personal memory you own, in files you can actually read.**

`nanomem` turns chats, notes, and exports into a markdown memory system that an LLM can update and retrieve as facts evolve over time. The result stays inspectable, portable, and user-owned instead of disappearing into hidden vector state.

<div align="center">
<video src="https://github.com/user-attachments/assets/fb59c332-2f93-415a-b514-571491bec565" width="60%" controls></video>
</div>

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
- **Automatic expiry.** Time-bound facts (a bee sting, a trip, a short-term plan) are tagged with an expiry date at write time and archived automatically when that date passes.
- **Conflict-aware updates.** Resolve outdated or contradictory facts using recency, source, and confidence.
- **Import your existing history.** Start from ChatGPT exports, Claude exports, [OA Chat](https://chat.openanonymity.ai) exports, transcripts, message arrays, markdown notes, or whole markdown directories.
- **Portable memory exchange.** Export full memory state as plain text, ZIP, or Open Memory Format (OMF), and merge OMF documents back in programmatically.
- **Flexible storage.** Run on local files, IndexedDB, in-memory storage, or a custom backend.
- **Built to plug in.** Use it from the CLI, as a library, or as a memory layer for other agents.

## Quick start

Install:

```bash
npm install -g @openanonymity/nanomem
```

Set up once:

```bash
nanomem login
```

This walks you through provider, model, API key, and where to store your memory. Config is saved to `~/.config/nanomem/config.json`. Filesystem memory lives in `~/nanomem/` by default.

Add facts directly:

```bash
nanomem add "Mise just crossed 200 active users this week."
nanomem update "Mise hit 250 users after the Indie Hackers post."
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
nanomem retrieve-adaptive "what deadlines do those projects have?" "$(nanomem retrieve 'what are my current projects?')"
```

Delete facts from memory:

```bash
nanomem delete "my old recipe scraping approach"
nanomem delete "my old recipe scraping approach" --deep
```

Compact and clean up memory:

```bash
nanomem compact   # full dedup + semantic review (requires LLM)
nanomem prune     # archive expired facts only, no LLM needed
```

Scripted setup also works:

```bash
nanomem login --provider openai --api-key sk-... --model gpt-5.4-mini
nanomem login --provider anthropic --api-key sk-ant-... --model claude-sonnet-4-6 --path ~/project/memory
```

Supported providers include OpenAI, Anthropic, Tinfoil, OpenRouter, and OpenAI-compatible endpoints via `--base-url`.

When `provider` is `tinfoil`, nanomem uses the Tinfoil SDK and fails
closed on enclave attestation verification before any inference request is
sent. The SDK is listed as a dependency and loaded lazily at runtime.

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
   prompt crafting / retrieval
   retrieve -> augment_query(user_query, memory_files)
   -> minimized reviewable prompt
            |
            v
       memory compact
       dedup + temporal cleanup + history preservation
```

The core engine has three parts:

- **Ingestion.** Extract durable facts from conversations or documents and organize them into topic files.
- **Retrieval.** Navigate the memory filesystem and assemble relevant context for a query.
- **Adaptive retrieval.** Reuse memory that was already retrieved earlier in a session, answer directly from it when possible, and only fetch missing facts when needed.
- **Compaction.** Deduplicate repeated facts, keep current memory concise, and move stale or superseded facts into history.

## Memory format

Memory is stored as markdown with structured metadata:

```md
# Memory: Work

## Working memory (current context subject to change)
- Preparing for a product launch next month | topic=work | tier=working | status=active | source=user_statement | confidence=high | updated_at=2026-04-07 | review_at=2026-04-20

## Long-term memory (stable facts that are unlikely to change)
- Leads the backend team at Acme | topic=work | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2026-04-07

## History (no longer current)
- Previously lived in New York | topic=personal | tier=history | status=superseded | source=user_statement | confidence=high | updated_at=2024-06-01
```

That structure is what lets the system do more than retrieval: it can keep track of source, confidence, recency, temporary context, and historical state.

Time-bound facts carry an `expires_at` date. The LLM reasons about when each fact will stop being relevant and sets the date at write time — no fixed rules or categories. Facts past their expiry date are archived automatically during `compact` or on demand with `prune`.

```md
- Bee sting on hand, area still red as of 2026-01-09 | topic=health | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2026-01-09T16:06 | expires_at=2026-01-23
- Visiting Portland next weekend to see Jake | topic=travel | tier=working | status=active | source=user_statement | confidence=high | updated_at=2026-01-09T16:06 | expires_at=2026-01-20
```

## Using it in code

```js
import { createMemoryBank } from '@openanonymity/nanomem';

const memory = createMemoryBank({
  llm: { apiKey: 'sk-...', model: 'gpt-5.4-mini' },
  storage: 'filesystem',
  storagePath: '~/nanomem'
});

await memory.init();

await memory.ingest([
  { role: 'user', content: 'I just moved to Seattle.' },
  { role: 'assistant', content: 'Noted.' }
]);

const result = await memory.retrieve('Where do I live now?');
await memory.compact();       // full dedup + semantic review
await memory.pruneExpired();  // archive expired facts, no LLM needed

const omf = await memory.exportOmf();
const preview = await memory.previewOmfImport(omf);
await memory.importOmf(omf);
```

## Common commands

```bash
nanomem add <text>                           # add new facts
nanomem update <text>                        # correct existing facts
nanomem delete <query>                       # delete facts matching a query
nanomem delete <query> --deep                # delete across all files (thorough)
nanomem import <file|dir|->                  # import history or notes
nanomem retrieve <query> [--context <file>]  # retrieve relevant context
nanomem retrieve-adaptive <query> [<already-retrieved-context>] [--context <file>]
                                           # reuse prior retrieved context and only fetch missing memory
nanomem tree                                 # browse memory files
nanomem compact                              # deduplicate and archive (requires LLM)
nanomem prune                                # archive expired facts (no LLM)
nanomem export --format zip                  # export everything
nanomem status                               # show config and stats
```

For terminal use, `--render` will format markdown-heavy output like `read` and `retrieve` into a more readable ANSI-rendered view while leaving `--json` and piped output unchanged.

## Multi-turn retrieval

`nanomem retrieve` is the basic one-shot path: it searches memory and returns relevant context for a query.

`nanomem retrieve-adaptive` is designed for multi-turn sessions where some memory was already retrieved earlier in the conversation. It takes the current query plus the already retrieved memory context and decides whether:

- the existing context already answers the question
- new retrieval is needed to fill in missing facts
- nothing relevant is available beyond what is already in the session

When the existing context is sufficient, `retrieve-adaptive` should answer directly from that context instead of retrieving again. When it is only partially sufficient, it should retrieve only the missing information.

Examples:

```bash
# first turn
nanomem retrieve "what are my current projects?"

# follow-up that should be answerable from the prior retrieved context
nanomem retrieve-adaptive "what deadlines do those projects have?" "$(nanomem retrieve 'what are my current projects?')"

# pipe the earlier retrieval into adaptive retrieval instead of using command substitution
nanomem retrieve "what are my current projects?" | \
  nanomem retrieve-adaptive "what deadlines do those projects have?"
```

Use `--context <file>` with either retrieval command when you want recent conversation turns to help resolve references like "that", "them", or "those projects".

## Import formats

`nanomem import` supports:

- ChatGPT exports (`conversations.json` from "Export data")
- Claude exports (`conversations.json` from "Export data")
- [OA Chat](https://chat.openanonymity.ai) exports
- markdown notes
- recursive markdown directory imports
- JSON message arrays
- plain text `User:` / `Assistant:` transcripts

Import can operate in both conversation-oriented and document-oriented modes, depending on the source or explicit flags.

```bash
nanomem import conversations.json              # auto-detects ChatGPT or Claude format
nanomem import conversations.json --format claude   # explicit Claude format
nanomem import conversations.json --format chatgpt  # explicit ChatGPT format
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

OMF spec: [docs/omf.md](./docs/omf.md)

## License

This project is licensed under the MIT License.

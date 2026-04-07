# @openanonymity/nanomem

Personal memory you own.

Import your ChatGPT history, notes, or conversation logs into a markdown memory folder that you can inspect, version, back up, and use from any agent.

`nanomem` uses an LLM to decide what to save, what to retrieve, and how to consolidate updates over time, but the result stays in human-readable files instead of hidden vector state.

## Why `nanomem`

- Import existing history from tools like ChatGPT and OA exports
- Keep memory in plain markdown files you can read and edit yourself
- Use it as a personal memory folder or plug it into agents and scripts
- Avoid lock-in: your memory is portable, local-first, and easy to export

## Getting Started

```bash
npm install -g @openanonymity/memory
```

### Set up once

```bash
memory login
```

This walks you through your provider, model, API key, and where to store your memory folder.

Supports OpenAI, Anthropic, Tinfoil, and OpenAI-compatible endpoints. Your config is saved to `~/.nanomem/config.json`, and your memory lives in `~/.memory/` by default as plain markdown files.

Once you're set up, import the history or notes you want `nanomem` to organize:

```bash
memory import conversations.json
memory import my-notes.md
memory import ./notes/
```

`nanomem` turns those inputs into a persistent folder of human-readable memory that you can inspect, version, back up, and plug into your agents.

Ask questions against that memory at any time:

```bash
memory retrieve "what are my hobbies?"
```

### Scripted setup

```bash
memory login --provider openai --api-key sk-... --model gpt-5.4-mini
memory login --provider anthropic --api-key sk-ant-... --model claude-sonnet-4-6 --path ~/project/memory
```

Use flags when you're wiring `nanomem` into agents, CI, or local scripts.

## Common Commands

```bash
memory import conversation.json    # import a conversation export
memory import my-notes.md          # import markdown notes
memory import ./notes/             # import a whole notes folder
memory retrieve "what are my hobbies?"
memory compact                     # deduplicate and archive stale facts
memory status                      # show config + storage stats
```

### Commands

```
Setup:
  login                                   Configure provider, model, API key, and storage path
  status                                  Show current config and storage stats

Info:
  status                                  Show config and storage stats

Engine:
  init                                    Initialize storage (seeds default files)
  import <file|dir|->                     Import conversations and extract facts
  retrieve <query> [--context <file>]     Retrieve relevant context for a query
  compact                                 Deduplicate and archive stale facts

Storage:
  ls [path]                               List files and directories
  read <path>                             Read a file
  write <path> --content <text>           Write content to a file (or pipe stdin)
  delete <path>                           Delete a file
  search <query>                          Search files by keyword
  export [--format txt|zip]               Export all memory
  clear --confirm                         Delete all memory files
```

### Import Formats

`memory import` auto-detects the input format:

- **ChatGPT export** — `conversations.json` from ChatGPT's "Export data"
- **OA Fastchat export** — JSON with `data.chats.sessions`
- **JSON messages array** — `[{role, content}, ...]`
- **Plain text** — `User:` / `Assistant:` lines
- **Markdown notes** — any other text input; splits by top-level headings
- **Directory** — pass a folder to import all `.md` files recursively
- Pipe from stdin: `echo '[{"role":"user","content":"I like cats"}]' | memory import -`

### Flags and Overrides

Most users only need `memory login`. These flags are mainly for one-off overrides, agents, and scripts:

```
--api-key <key>         LLM API key
--model <model>         Model ID
--provider <name>       Provider: openai | anthropic | tinfoil | custom
--base-url <url>        Custom API endpoint
--storage <type>        Storage backend: filesystem | ram | indexeddb (default: filesystem)
--path <dir>            Storage directory (default: ~/.memory)
--json                  Force JSON output
```

Environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TINFOIL_API_KEY`) work as fallbacks if you haven't run `memory login`. The generic `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`, and `LLM_PROVIDER` also work as fallbacks.

Resolution order (highest wins): **CLI flags > config file > env vars > defaults**

## Using It In Code

### Quick Start

```js
import { createMemoryBank } from '@openanonymity/memory';

const memory = createMemoryBank({
    llm: { apiKey: 'sk-...', model: 'gpt-5.4' },
});

await memory.init();
```

### High-level API

```js
// Save facts from a conversation
await memory.ingest([
    { role: 'user', content: 'I just moved to San Francisco' },
    { role: 'assistant', content: 'Welcome to SF!' },
]);

// Retrieve relevant context for a query
const result = await memory.retrieve('Where do I live?');
// → { files, paths, assembledContext }

// With conversation context (helps resolve "that", "the same", etc.)
const result = await memory.retrieve('Tell me more about that', conversationText);

// Compact all memory files (dedup, archive stale facts)
await memory.compact();
```

### Storage API

```js
await memory.storage.read('health/allergies.md');
await memory.storage.write('health/allergies.md', content);
await memory.storage.delete('temporary/old.md');
await memory.storage.exists('health/allergies.md');
await memory.storage.search('peanut');
await memory.storage.ls('health');
await memory.storage.getTree();
await memory.storage.rebuildTree();
await memory.storage.exportAll();
await memory.storage.clear();
```

### Portability Utilities

```js
const str = await memory.serialize();  // single string, all files
const zip = await memory.toZip();      // Uint8Array, valid ZIP
```

The standalone functions also work directly on an `exportAll()` result:

```js
import { serialize, deserialize, toZip } from '@openanonymity/memory/utils';

const records = await memory.storage.exportAll();
const str = serialize(records);          // → string
const back = deserialize(str);           // → [{ path, content }, ...]
const zip = toZip(records);              // → Uint8Array
```

## Configuration

```js
const memory = createMemoryBank({
    // LLM provider (required — pick one)
    llm: { apiKey, baseUrl, model, provider, headers },
    // or bring your own client:
    llmClient: { createChatCompletion, streamChatCompletion },
    model: 'gpt-5.4',

    // Storage backend (default: 'ram')
    storage: 'ram',              // 'ram' | 'filesystem' | 'indexeddb' | custom backend object
    storagePath: './memory/',    // for 'filesystem' backend

    // Callbacks (optional)
    onProgress: ({ stage, message }) => {},   // retrieval progress
    onToolCall: (name, args, result) => {},   // extraction tool calls
    onModelText: (text) => {},                // intermediate model text
});
```

### LLM Providers

```js
// OpenAI / Tinfoil / OpenRouter
createMemoryBank({
    llm: { apiKey: 'sk-...', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' },
});

// Anthropic
createMemoryBank({
    llm: { apiKey: 'sk-ant-...', provider: 'anthropic', model: 'claude-sonnet-4-6' },
});

// Custom LLM client
createMemoryBank({
    llmClient: {
        async createChatCompletion({ model, messages, tools, max_tokens, temperature }) {
            // → { content: string, tool_calls: [{ id, function: { name, arguments } }] }
        },
    },
    model: 'your-model-id',
});
```

## Storage Backends

| Config | Environment | Persistence |
|--------|-------------|-------------|
| `'ram'` (default) | Any | None — data lost on exit |
| `'filesystem'` | Node.js | Files on disk |
| `'indexeddb'` | Browser | IndexedDB |
| Custom object | Any | You decide |

### Custom Backend

Extend `BaseStorage` and implement the required methods:

```js
import { BaseStorage } from '@openanonymity/memory/backends';

class MyStorage extends BaseStorage {
    async init() { }
    async _readRaw(path) { }              // → string | null
    async _writeRaw(path, content, meta) { } // meta: { oneLiner, itemCount, titles }
    async delete(path) { }
    async exists(path) { }               // → boolean
    async rebuildTree() { }
    async exportAll() { }                // → [{ path, content, updatedAt, itemCount, oneLiner }]
    async clear() { }                    // remove all data, re-init to ready state
}

// BaseStorage provides: read(), write(), search(), ls(), getTree()
```

## How Memory Works On Disk

Memory files are plain markdown with structured bullet metadata:

```markdown
# Memory: Health

## Working
### Current context
- Currently adjusting medication | tier=working | source=user_statement | confidence=high | updated_at=2025-03-12

## Long-Term
### Stable facts
- Allergic to peanuts | tier=long_term | source=user_statement | confidence=high | updated_at=2025-03-12

## History
### No longer current
- Was on old medication | tier=history | status=superseded | updated_at=2025-03-12
```

There is no hardcoded folder structure. Memory organizes files by topic as it learns about the user.

## Source Layout

```
src/
├── index.js          — createMemoryBank(), public API
├── cli.js            — CLI entry point
├── cli/              — CLI: auth, config, commands, help, output formatting
├── engine/           — LLM-driven: retriever, ingester, compactor, executors, toolLoop
├── backends/         — storage backends: ram, filesystem, indexeddb, BaseStorage, schema
├── bullets/          — bullet format utilities: parser, normalize, scoring, compaction
├── llm/              — LLM client wrappers: openai, anthropic
├── imports/          — import parsers: chatgpt, oaFastchat, markdown
└── utils/            — portability (serialize/toZip)
```

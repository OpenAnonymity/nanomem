# @openanonymity/memory

LLM-driven memory for agentic systems. Plug it into any agent to give it persistent, structured memory backed by markdown files.

The system uses an LLM to decide what to save (extraction), what to recall (retrieval), and how to consolidate (compaction). Memory is stored as human-readable markdown — not hidden vector state.

## CLI

```bash
npm install -g @openanonymity/memory
```

Set an API key and start using it:

```bash
# Any one of these will work:
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export TINFOIL_API_KEY=...

memory init
memory import conversation.json
memory retrieve "what are my hobbies?"
memory status
```

By default, memory stores files in `~/.memory` using the filesystem backend, and auto-detects your LLM provider from the API key you set (defaulting to `gpt-4o` for OpenAI, `claude-sonnet-4-6` for Anthropic, `kimi-k2-5` for Tinfoil). Override with flags:

```bash
memory init --path ~/my-memory --provider anthropic --model claude-sonnet-4-6
```

### Commands

```
Info:
  status                                  Show config and storage stats

Engine:
  init                                    Initialize storage (seeds default files)
  import <file|->                         Import conversations and extract facts
  retrieve <query> [--context <file>]     Retrieve relevant context for a query
  compact                                 Deduplicate and archive stale facts

Storage:
  ls [path]                               List files and directories
  read <path>                             Read a file
  write <path> --content <text>           Write content to a file (or pipe stdin)
  delete <path>                           Delete a file
  search <query>                          Search files by keyword
  export [--format json|zip]              Export all memory
  clear --confirm                         Delete all memory files
```

### Global Flags

```
--api-key <key>         LLM API key (env: OPENAI_API_KEY, etc.)
--model <model>         Model ID (env: LLM_MODEL)
--provider <name>       Provider: openai | anthropic | tinfoil (env: LLM_PROVIDER)
--base-url <url>        Custom API endpoint (env: LLM_BASE_URL)
--storage <type>        Storage backend: filesystem | ram (default: filesystem)
--path <dir>            Storage directory (default: ~/.memory)
--json                  Force JSON output
```

### Import Formats

`memory import` auto-detects the input format:

- **OA Fastchat export** — JSON with `data.chats.sessions`
- **JSON messages array** — `[{role, content}, ...]`
- **Plain text** — `User:` / `Assistant:` lines
- Pipe from stdin: `echo '[{"role":"user","content":"I like cats"}]' | memory import -`

### Environment Variables

```
OPENAI_API_KEY          OpenAI API key
ANTHROPIC_API_KEY       Anthropic API key
TINFOIL_API_KEY         Tinfoil API key
LLM_API_KEY             Override API key for any provider
LLM_BASE_URL            Override base URL
LLM_MODEL               Override model
LLM_PROVIDER            Override provider detection
```

## Library API

### Quick Start

```js
import { createMemory } from '@openanonymity/memory';

const memory = createMemory({
    llm: { apiKey: 'sk-...', model: 'gpt-4o' },
});

await memory.init();
```

### High-level (LLM-driven)

```js
// Save facts from a conversation
await memory.extract([
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

### Low-level (direct storage)

```js
await memory.storage.read('health/allergies.md');
await memory.storage.write('health/allergies.md', content);
await memory.storage.delete('temporary/old.md');
await memory.storage.exists('health/allergies.md');
await memory.storage.search('peanut');
await memory.storage.ls('health');
await memory.storage.getIndex();
await memory.storage.rebuildIndex();
await memory.storage.exportAll();
await memory.storage.clear();
```

### Utilities (portability)

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
const memory = createMemory({
    // LLM provider (required — pick one)
    llm: { apiKey, baseUrl, model, provider, headers },
    // or bring your own client:
    llmClient: { createChatCompletion, streamChatCompletion },
    model: 'gpt-4o',

    // Storage backend (default: 'ram')
    storage: 'ram',              // 'ram' | 'filesystem' | 'indexeddb' | custom backend object
    storagePath: './memory/',    // for 'filesystem' backend

    // Callbacks (optional)
    onProgress: ({ stage, message }) => {},   // retrieval progress
    onToolCall: (name, args, result) => {},   // extraction tool calls
    onModelText: (text) => {},                // intermediate model text
});
```

## LLM Providers

### OpenAI / Tinfoil / OpenRouter

```js
createMemory({
    llm: { apiKey: 'sk-...', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
});
```

### Anthropic

```js
createMemory({
    llm: { apiKey: 'sk-ant-...', provider: 'anthropic', model: 'claude-sonnet-4-6' },
});
```

### Custom LLM Client

```js
createMemory({
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
    async _writeRaw(path, content, meta) { } // meta: { l0, itemCount, titles }
    async delete(path) { }
    async exists(path) { }               // → boolean
    async rebuildIndex() { }
    async exportAll() { }                // → [{ path, content, updatedAt, itemCount, l0 }]
    async clear() { }                    // remove all data, re-init to ready state
}

// BaseStorage provides: read(), write(), search(), ls(), getIndex()
```

## How Memory is Stored

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

There is no hardcoded folder structure. The LLM organizes files into folders naturally based on the topics discussed.

## Source Layout

```
src/
├── index.js          — createMemory(), public API
├── cli.js            — CLI entry point
├── cli/              — CLI: config, commands, help, output formatting
├── engine/           — LLM-driven: retrieval, extractor, compactor, executors, toolLoop
├── backends/         — storage backends: ram, filesystem, indexeddb, BaseStorage, schema
├── bullets/          — bullet format utilities: parser, normalize, scoring, compaction
├── llm/              — LLM client wrappers: openai, anthropic
├── imports/          — chat format parsers: oaFastchat
└── utils/            — portability (serialize/toZip)
```

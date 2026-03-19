# @openanonymity/memory

LLM-driven personal memory with agentic retrieval, extraction, and compaction.

The memory system stores facts as metadata-rich markdown bullets organized in a virtual filesystem. An LLM agent decides what to save (extraction), what to retrieve (retrieval), and how to consolidate (compaction).

## Quick Start

```js
import { createMemory } from '@openanonymity/memory';

const memory = createMemory({
    llm: {
        apiKey: 'sk-...',
        baseUrl: 'https://api.openai.com/v1',  // or Tinfoil, OpenRouter, etc.
        model: 'gpt-4o',
    },
    storage: 'memory',  // 'indexeddb' | 'filesystem' | 'memory' | custom backend
});

await memory.init();
```

### Retrieve context for a query

```js
const result = await memory.retrieve('What are my allergies?', {
    conversationText,  // helps resolve "that"/"the same" references
    onProgress,        // progress callback ({ stage, message })
    signal,            // AbortSignal
});
// → { files, paths, assembledContext }
```

### Extract facts from a conversation

```js
const { status, writeCalls } = await memory.extract([
    { role: 'user', content: 'I just moved to San Francisco' },
    { role: 'assistant', content: 'Welcome to SF! ...' },
]);
```

### Compact memory files

```js
// Force-compact all files now
await memory.compact();

// Or: only compact if ≥6 hours since last run (opportunistic)
await memory.maybeCompact();
```

### Direct file access

```js
await memory.read('health/allergies.md');
await memory.write('health/allergies.md', content);
await memory.search('peanut');
await memory.ls('health');
await memory.delete('temporary/old-note.md');
```

## LLM Providers

### OpenAI / Tinfoil / OpenRouter (any OpenAI-compatible API)

```js
const memory = createMemory({
    llm: {
        apiKey: 'sk-...',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
    },
});
```

For Tinfoil, just change the `baseUrl`:

```js
const memory = createMemory({
    llm: {
        apiKey: 'your-tinfoil-key',
        baseUrl: 'https://your-tinfoil-endpoint/v1',
        model: 'kimi-k2-5',
    },
});
```

### Anthropic

```js
const memory = createMemory({
    llm: {
        apiKey: 'sk-ant-...',
        baseUrl: 'https://api.anthropic.com',
        provider: 'anthropic',  // auto-detected from baseUrl
        model: 'claude-sonnet-4-6',
    },
});
```

### Custom LLM Client

```js
const memory = createMemory({
    llmClient: {
        async createChatCompletion({ model, messages, tools, max_tokens, temperature }) {
            // → { content: string, tool_calls: [{id, function: {name, arguments}}] }
        },
        // Optional (for reasoning token streaming):
        async streamChatCompletion({ model, messages, tools, max_tokens, temperature, onDelta, onReasoning }) {
            // → same return shape
        },
    },
    model: 'your-model-id',
});
```

## Storage Backends

| Backend | Environment | Usage |
|---------|------------|-------|
| `'memory'` | Any | In-memory (default). Data lost on exit. Good for testing. |
| `'indexeddb'` | Browser | Persistent browser storage. |
| `'filesystem'` | Node.js | Stores `.md` files on disk. |
| Custom object | Any | Provide your own backend implementing the storage interface. |

```js
// Filesystem backend
const memory = createMemory({
    llm: { apiKey: '...', model: 'gpt-4o' },
    storage: 'filesystem',
    storagePath: '~/.myapp/memory/',
});

// Custom backend
const memory = createMemory({
    llm: { apiKey: '...', model: 'gpt-4o' },
    storage: myCustomBackend,  // object with init, read, write, delete, exists, ls, search, getIndex, rebuildIndex, exportAll
});
```

## Storage Interface

Every backend must implement:

```
init()                → void
read(path)            → string | null
write(path, content)  → void
delete(path)          → void
exists(path)          → boolean
ls(dirPath)           → { files: string[], dirs: string[] }
search(query)         → [{ path, snippet }]
getIndex()            → string
rebuildIndex()        → void
exportAll()           → [{ path, content, updatedAt, itemCount, l0 }]
```

## Bullet Format

Facts are stored as metadata-rich markdown bullets:

```
- Fact text | topic=health | tier=long_term | status=active | updated_at=2025-03-12 | expires_at=2025-06-12
```

Files are organized into Working, Long-Term, and History sections:

```markdown
# Memory: Health

## Working
### Current context
- Adjusting thyroid dosage this month | topic=health | tier=working | status=active | updated_at=2025-03-12 | review_at=2025-04-01

## Long-Term
### Stable facts
- Takes thyroid medication daily | topic=health | tier=long_term | status=active | updated_at=2025-03-12

## History
### No longer current
- Was taking old medication | topic=health | tier=history | status=superseded | updated_at=2024-01-15
```

## Module Exports

```js
// Main factory
import { createMemory } from '@openanonymity/memory';

// LLM clients
import { createOpenAIClient } from '@openanonymity/memory/llm';
import { createAnthropicClient } from '@openanonymity/memory';

// Bullet utilities
import { parseMemoryBullets, compactBullets } from '@openanonymity/memory/bullets';

// Storage interface factories
import { createRetrievalExecutors, createExtractionExecutors } from '@openanonymity/memory/storage';
```

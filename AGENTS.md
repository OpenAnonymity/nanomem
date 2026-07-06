# Repository Guidelines

## Memory Model (read this first)

`nanomem` stores personal memory as user-owned markdown files. The important product guarantee is that memory stays inspectable, editable, portable, and under the user's control instead of being hidden in opaque vector state.

Before changing memory behavior, read `docs/memory-system.md`. If the change touches Open Memory Format import/export, also read `docs/omf.md`.

Preserve these invariants:

- Memory files should remain plain markdown that users can read and edit.
- Current facts, working context, expired facts, and history should remain distinguishable through structured bullet metadata.
- Retrieval should prefer high-signal excerpts over dumping entire files.
- Deterministic fallback paths should work without network access where practical.
- Tests and examples must not use real user memory directories or real API keys.

## Agent Workflow

For ongoing work, agents should follow this order:

1. Read the relevant docs first: `docs/memory-system.md` for memory architecture, `docs/omf.md` for OMF changes, and `README.md` for public CLI/API behavior.
2. Explore the code paths that implement the affected behavior, then make the change.
3. Update docs when user-facing commands, public API examples, memory semantics, supported formats, or OMF behavior change.
4. Add or update focused tests for non-trivial behavior changes.
5. Before marking a substantial change done, review the final diff for memory-format regressions, missed index refreshes, network-dependent tests, secret handling, and user-facing docs drift.

Before marking any repo-changing task done, perform an adversarial review pass. This includes code, tests, docs, config, workflows, packaging, and PR changes. It is a required quality gate, not an optional polish step.

Use a review subagent for every repo-changing task when the environment exposes a subagent or delegation tool. Treat valid findings as part of the same task: fix them, rerun relevant verification, and review again when the fix materially changes the diff.

If no existing doc is a good fit for an architectural note, add a new doc under `docs/` and link it from `README.md` when it is user-facing.

## Agent Behavior Principles

Bias toward caution over speed when code, memory format, privacy, or user data is involved. For trivial tasks, use judgment and keep the process lightweight.

- Think before coding. State assumptions when the request is ambiguous, surface tradeoffs, and ask before making risky product, privacy, or data-format decisions.
- Prefer simplicity. Implement the minimum code that solves the request; avoid speculative features, unnecessary configurability, and abstractions that only serve one use.
- Make surgical changes. Touch only the files needed for the task, match existing style, and do not refactor adjacent code unless it is required to complete the request safely.
- Clean up only your own edits. Remove imports, variables, helpers, and tests made obsolete by your change, but do not delete unrelated pre-existing code without being asked.
- Work toward verifiable success. For non-trivial tasks, identify how the change will be checked, then loop until the relevant test, command, or manual verification passes.
- Keep every changed line traceable to the user's request or to verification needed for that request.

## Prompt Design

When rewording or extending prompts under `src/prompts/`, favor guiding principles over concrete examples. Do not encode narrow, overfit example catalogs that assume users only talk about a few specific topics or communicate in one particular format; nanomem must generalize across arbitrary subject matter and forms of communication, so prompts should teach the model how to reason rather than pattern-match a fixed domain.

- Prefer general principles over example dumps. Load-bearing rules can stay, but avoid long topic-specific example lists that bias ingestion or retrieval toward a narrow domain and degrade handling of everything else.
- Keep parallel prompt paths in sync. When you change a conversation prompt, apply the corresponding change to the document prompt (and vice versa); when you change retrieval, consider the matching change to adaptive retrieval. The same applies across any ingestion/deletion/retrieval variants that share intent.

## Project Structure & Module Organization

This is a Node.js 20+ ESM package and CLI:

- `src/index.js`: Public library entrypoint. Exports `createMemoryBank()` and related utilities.
- `src/cli.js`: CLI entrypoint for the `nanomem` binary.
- `src/cli/`: CLI command parsing, config/auth helpers, help text, output formatting, spinner, and diffs.
- `src/tools/`: High-level memory operations.
  - `retrieval.js`: Query retrieval, adaptive retrieval, and prompt augmentation.
  - `ingestion.js`: Conversation/document fact extraction into memory files.
  - `compaction.js`: Deduplication, expiry pruning, and history preservation.
  - `deletion.js`: Query-driven memory deletion.
  - `executors.js`: Tool-call execution support for LLM-driven operations.
- `src/internal/storage/`: Storage backends and contracts.
  - `filesystem.js`: Local markdown folder storage.
  - `indexeddb.js`: Browser storage.
  - `ram.js`: In-memory backend used by tests and ephemeral callers.
  - `BaseStorage.js`: Shared search/tree behavior.
  - `schema.js`: Seed/default memory layout.
- `src/internal/format/`: Markdown memory parser, normalization, BM25 search, scoring, compaction helpers, and `MemoryBulletIndex`.
- `src/internal/imports/`: Importers for ChatGPT, Claude, OA Fastchat, markdown, generic message arrays, transcripts, and directories.
- `src/internal/llm-client/`: Provider adapters for OpenAI-compatible APIs, Anthropic, and Tinfoil.
- `src/internal/omf.js`: Open Memory Format export/import/preview logic.
- `src/internal/portability.js`: Plain text and ZIP export helpers.
- `src/prompts/`: Prompt text for retrieval, compaction, ingestion, and deletion.
- `src/browser.js` and root `browser.js`: Browser-facing exports.
- `test/`: Node built-in test runner coverage, grouped by subsystem.
- `docs/`: Design and format documentation.
- `chatgpt/` and `eval/`: Demo/evaluation data and helper scripts; avoid assuming these are part of the npm package surface.
- `types/`: Generated declaration files.

## Build, Test, and Development Commands

Install dependencies:

```bash
npm ci
```

Run all tests:

```bash
npm test
```

Run a focused test file:

```bash
node --test test/engine/search.test.js
```

Generate/check TypeScript declaration output:

```bash
npm run build:types
```

Run the local CLI entrypoint:

```bash
node src/cli.js --help
node src/cli.js <command>
```

Package lifecycle hooks run `tsc` through `prepack` and `prepublishOnly`. The GitHub release workflow uses Node 20, `npm ci`, `npm test`, and `npm publish --provenance --access public`.

## Coding Style & Naming Conventions

- Use ES modules, 4-space indentation, and trailing semicolons.
- Prefer `const`/`let`; use camelCase for functions and methods, PascalCase for classes/types.
- Source is JavaScript with JSDoc type annotations. Keep JSDoc accurate when changing public APIs or typed internal contracts.
- Keep comments concise and reserved for non-obvious memory, retrieval, scoring, prompt, or storage behavior.
- Follow existing module boundaries; avoid duplicating helpers already present in `src/internal/format/`, `src/internal/storage/`, or `src/tools/`.
- When storage content changes through public memory objects, keep `MemoryBulletIndex` in sync. The write/delete/rebuild wrappers in `createMemoryBank()` refresh the index intentionally.
- Keep markdown memory output stable and readable. Do not introduce metadata formats that make manual inspection difficult.
- Treat LLM clients as injectable dependencies. Avoid hard-coding provider-specific behavior outside `src/internal/llm-client/` unless the existing abstraction requires it.
- Keep CLI output compatible with `--json`, piped output, and `--render` behavior described in `README.md`.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Existing tests generally build small in-memory fixtures and avoid live network calls.

Run the narrowest relevant test first, then `npm test` when practical. Add or update tests when changing:

- markdown parsing, normalization, scoring, compaction, or BM25 behavior in `src/internal/format/`
- storage backend behavior in `src/internal/storage/`
- import detection/conversion in `src/internal/imports/`
- retrieval, adaptive retrieval, ingestion, deletion, compaction, or expiry behavior in `src/tools/`
- OMF import/export/preview behavior in `src/internal/omf.js`
- public API behavior in `src/index.js`
- CLI command parsing, rendering, or JSON output in `src/cli.js` or `src/cli/`

Prefer `InMemoryStorage` for unit tests. For filesystem integration tests, use an explicit temporary directory and do not touch the user's configured memory path reported by `nanomem status`.

LLM-dependent behavior should be tested with fake clients or deterministic fallbacks. Do not require provider credentials for the default test suite.

## Commit & Pull Request Guidelines

Recent commits use short, present-tense summaries such as `Simplify adaptive retrieval metadata` and `docs: fix BaseStorage search() return-shape comment`. Keep the first line concise and group related changes together.

Pull requests should include:

- a concise summary of user-facing impact
- tests run, including focused test files when relevant
- docs updated or an explanation for why docs were not needed
- notes on any memory-format, import/export, or provider behavior changes

## API Keys, Privacy, And Security

- Do not hard-code API keys, tokens, endpoints with credentials, or local user memory paths.
- CLI config is stored outside the repo by default, typically under `~/.config/nanomem/config.json`; do not read or mutate it in tests unless the test explicitly isolates config paths.
- Tests and demos should use RAM storage or temporary paths instead.
- LLM providers include OpenAI-compatible APIs, Anthropic, Tinfoil, OpenRouter, and custom `baseUrl` endpoints. Keep provider-specific secrets out of logs and errors.
- Tinfoil support is expected to fail closed on attestation verification before inference requests are sent.
- When adding logging or progress output, avoid printing prompt contents, retrieved memory, API keys, or full file contents unless the command explicitly requests it.

## Storage And Format Notes

- Memory bullets use metadata such as `topic`, `tier`, `status`, `source`, `confidence`, `updated_at`, `review_at`, and `expires_at`.
- Expired facts should be archived/pruned without losing historical context.
- `compact` is LLM-assisted semantic cleanup; `prune`/`pruneExpired` should remain deterministic and not require an LLM.
- Keyword search uses BM25 plus substring recall. Be careful not to regress short-query or substring-only matches.
- Direct file reads and retrieval should keep context focused through query-aware excerpts where possible.
- OMF changes must preserve preview-before-import behavior and avoid destructive merges unless explicitly requested by the API/user flow.

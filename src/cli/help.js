/**
 * CLI help text.
 */

export const GLOBAL_HELP = `Usage: nanomem <command> [args] [flags]

Commands:

  Setup:
    login                                   Configure provider, model, API key, and storage path
    status                                  Show current config and storage stats

  Memory:
    add <text>                              Add new facts from text (creates or appends files)
    update <text>                           Edit existing facts from text (only modifies existing files)
    import <file|dir|->                     Import conversations or notes and extract facts
    retrieve <query> [--context <file>]     Retrieve relevant context for a query
    retrieve-adaptive <query> [<already-retrieved-context>] [--context <file>]
                                            Reuse prior retrieved context and only fetch missing memory
    compact                                 Deduplicate and archive stale facts
    prune                                   Archive facts whose expiry date has passed (fast, no LLM)
    export [--format txt|zip]               Export all memory to a file

  Storage:
    ls [path]                               List files and directories
    read <path>                             Read a file
    write <path> --content <text>           Write content to a file (or pipe stdin)
    delete <path>                           Delete a file
    search <query>                          Search files by keyword
    clear --confirm                         Delete all memory files

Flags:
  --api-key <key>         LLM API key
  --model <model>         Model ID
  --provider <name>       Provider: openai | anthropic | tinfoil | custom
  --base-url <url>        Custom API endpoint
  --path <dir>            Storage directory (default: ~/nanomem)
  --json                  Force JSON output
  --render                Render markdown for terminal output
  -h, --help              Show help
  -v, --version           Show version

Examples:
  nanomem login
  nanomem add "User: I moved to Seattle."
  nanomem update "User: Actually I moved to Portland, not Seattle."
  nanomem import conversations.json
  nanomem import my-notes.md
  nanomem import ./notes/
  nanomem retrieve "what are my hobbies?"
  nanomem retrieve-adaptive "what deadlines do those projects have?" "$(nanomem retrieve 'what are my current projects?')"
  nanomem status
  nanomem export --format zip
`;

export const COMMAND_HELP = {
    add: 'Usage: nanomem add <text>\n\nAdd new facts from text. The LLM will create a new file or append to an existing one.\nAccepts quoted text or piped stdin.\nRequires an LLM API key.',
    update: 'Usage: nanomem update <text>\n\nEdit existing facts from text. The LLM will only modify files that already exist — no new files are created.\nAccepts quoted text or piped stdin.\nRequires an LLM API key.',
    retrieve: 'Usage: nanomem retrieve <query> [--context <file>]\n\nRetrieve relevant memory context for a query.\nRequires an LLM API key.',
    'retrieve-adaptive': `Usage: nanomem retrieve-adaptive <query> [<already-retrieved-context>] [--context <file>]

Adaptive retrieval for multi-turn sessions.

Behavior:
  - First checks whether the current query can already be answered from previously retrieved memory context
  - If yes, returns a normal answer without fetching any new memory
  - If not, retrieves only the missing information
  - If nothing new is needed or found, the result may be empty with an explanation

Inputs:
  - <query>: the current user question
  - <already-retrieved-context>: memory context already shown earlier in the session
  - --context <file>: optional recent conversation transcript for resolving references like "that" or "those projects"

Examples:
  nanomem retrieve-adaptive "what deadlines do those projects have?" "$(nanomem retrieve 'what are my current projects?')"
  nanomem retrieve "what are my current projects?" | nanomem retrieve-adaptive "what deadlines do those projects have?"

Requires an LLM API key.`,
    compact: 'Usage: nanomem compact\n\nDeduplicate and archive stale facts across all memory files.\nRequires an LLM API key.',
    prune: 'Usage: nanomem prune\n\nArchive any facts whose expires_at date has passed. Fast deterministic pass — no LLM required.',
    ls: 'Usage: nanomem ls [path]\n\nList files and directories in storage.',
    read: 'Usage: nanomem read <path>\n\nRead a file from storage.\nUse --render to format markdown files for terminal display.',
    write: 'Usage: nanomem write <path> [--content <text>]\n\nWrite content to a file. Reads from stdin if --content is not provided.',
    delete: 'Usage: nanomem delete <path>\n\nDelete a file from storage.',
    search: 'Usage: nanomem search <query>\n\nSearch files by keyword.',
    export: 'Usage: nanomem export [--format txt|zip]\n\nExport all memory to a timestamped file in the current directory.\nDefault format is txt (line-delimited text). Use --format zip for a ZIP archive.',
    import: `Usage: nanomem import <file|dir|->

Import conversations or notes and extract facts into memory.

Auto-detects format:
  - ChatGPT export (conversations.json from "Export data")
  - OA Fastchat export (JSON with data.chats.sessions)
  - JSON messages array ([{role, content}, ...])
  - Plain text (User:/Assistant: lines)
  - Markdown notes (splits by top-level headings)
  - Directory (imports all .md files recursively)

For multi-session exports, use --session-id or --session-title to filter.
Requires an LLM API key.`,
    clear: 'Usage: nanomem clear --confirm\n\nDelete all memory files. Requires --confirm to prevent accidental data loss.',
    status: 'Usage: nanomem status\n\nShow resolved config and storage statistics.',
    login: `Usage: nanomem login

Walks you through provider, model, API key, and storage path.
Config is saved to ~/.nanomem/config.json.

Non-interactive (for agents/scripts):
  nanomem login --provider openai --api-key sk-... --model gpt-5.4-mini
  nanomem login --provider anthropic --api-key sk-ant-... --path ~/project/memory`,
};

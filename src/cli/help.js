/**
 * CLI help text.
 */

export const GLOBAL_HELP = `Usage: nanomem <command> [args] [flags]

Commands:

  Setup:
    login                                   Configure provider, model, API key, and storage path
    status                                  Show current config and storage stats

  Memory:
    import <file|dir|->                     Import conversations or notes and extract facts
    retrieve <query> [--context <file>]     Retrieve relevant context for a query
    compact                                 Deduplicate and archive stale facts
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
  --path <dir>            Storage directory (default: ~/.memory)
  --json                  Force JSON output
  -h, --help              Show help
  -v, --version           Show version

Examples:
  nanomem login
  nanomem import conversations.json
  nanomem import my-notes.md
  nanomem import ./notes/
  nanomem retrieve "what are my hobbies?"
  nanomem status
  nanomem export --format zip
`;

export const COMMAND_HELP = {
    retrieve: 'Usage: nanomem retrieve <query> [--context <file>]\n\nRetrieve relevant memory context for a query.\nRequires an LLM API key.',
    compact: 'Usage: nanomem compact\n\nDeduplicate and archive stale facts across all memory files.\nRequires an LLM API key.',
    ls: 'Usage: nanomem ls [path]\n\nList files and directories in storage.',
    read: 'Usage: nanomem read <path>\n\nRead a file from storage.',
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

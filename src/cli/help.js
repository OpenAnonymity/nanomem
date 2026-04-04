/**
 * CLI help text.
 */

export const GLOBAL_HELP = `Usage: memory <command> [args] [flags]

Commands:

  Info:
    status                                  Show config and storage stats

  Engine:
    init                                    Initialize storage (seeds default files)
    import <file|->                         Import conversations and extract facts
    retrieve <query> [--context <file>]     Retrieve relevant context for a query
    compact                                 Deduplicate and archive stale facts
    export [--format txt|zip]               Export all memory to a txt file or a zip file

  Storage:
    ls [path]                               List files and directories
    read <path>                             Read a file
    write <path> --content <text>           Write content to a file (or pipe stdin)
    delete <path>                           Delete a file
    search <query>                          Search files by keyword
    clear --confirm                         Delete all memory files

Global flags:
  --api-key <key>         LLM API key (env: OPENAI_API_KEY, etc.)
  --model <model>         Model ID (env: LLM_MODEL)
  --provider <name>       Provider: openai | anthropic | tinfoil (env: LLM_PROVIDER)
  --base-url <url>        Custom API endpoint (env: LLM_BASE_URL)
  --storage <type>        Storage backend: filesystem | ram (default: filesystem)
  --path <dir>            Storage directory (default: ~/.memory)
  --json                  Print command results as JSON (for scripting)
  -h, --help              Show help
  -v, --version           Show version

Environment variables:
  OPENAI_API_KEY          OpenAI API key
  ANTHROPIC_API_KEY       Anthropic API key
  TINFOIL_API_KEY         Tinfoil API key
  LLM_API_KEY             Override API key for any provider
  LLM_BASE_URL            Override base URL
  LLM_MODEL               Override model
  LLM_PROVIDER            Override provider detection

Examples:
  memory init
  memory import conversation.json
  echo '[{"role":"user","content":"I like cats"}]' | memory import -
  memory import chatgpt-export.json
  memory retrieve "what are my hobbies?"
  memory write notes/todo.md --content "buy groceries"
  memory export
  memory export --format zip
`;

export const COMMAND_HELP = {
    init: 'Usage: memory init\n\nInitialize the storage backend. Creates seed files if empty.',
    retrieve: 'Usage: memory retrieve <query> [--context <file>]\n\nRetrieve relevant memory context for a query.\nRequires an LLM API key.',
    compact: 'Usage: memory compact\n\nDeduplicate and archive stale facts across all memory files.\nRequires an LLM API key.',
    ls: 'Usage: memory ls [path]\n\nList files and directories in storage.',
    read: 'Usage: memory read <path>\n\nRead a file from storage.',
    write: 'Usage: memory write <path> [--content <text>]\n\nWrite content to a file. Reads from stdin if --content is not provided.',
    delete: 'Usage: memory delete <path>\n\nDelete a file from storage.',
    search: 'Usage: memory search <query>\n\nSearch files by keyword.',
    export: 'Usage: memory export [--format txt|zip]\n\nExport all memory to a timestamped file in the current directory.\nDefault format is txt (line-delimited text). Use --format zip for a ZIP archive.',
    import: 'Usage: memory import <file|->\n\nImport conversations and extract facts into memory.\n\nAuto-detects format:\n  - OA Fastchat export (JSON with data.chats.sessions)\n  - JSON messages array ([{role, content}, ...])\n  - Plain text (User:/Assistant: lines)\n\nFor multi-session exports, use --session-id or --session-title to filter.\nRequires an LLM API key.',
    clear: 'Usage: memory clear --confirm\n\nDelete all memory files. Requires --confirm to prevent accidental data loss.',
    status: 'Usage: memory status\n\nShow resolved config and storage statistics.',
};

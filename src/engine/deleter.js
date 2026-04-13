/**
 * MemoryDeleter — targeted bullet deletion via agentic tool-calling.
 *
 * Takes a plain-text query (e.g. "my job at Acme") and uses the LLM to find
 * and delete only the matching bullets. Mirrors the retriever pattern but
 * writes instead of reads.
 *
 * Two modes:
 *   default — LLM searches the index for relevant files, reads and deletes.
 *   deep    — all files are enumerated upfront; LLM reads every one.
 */
/** @import { LLMClient, StorageBackend } from '../types.js' */
import { runAgenticToolLoop } from './toolLoop.js';
import { createDeletionExecutors } from './executors.js';
import { resolvePromptSet } from '../prompt_sets/index.js';

/** Tools used in default (index-guided) delete mode. */
const DELETION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'list_directory',
            description: 'List all files and subdirectories in a directory.',
            parameters: {
                type: 'object',
                properties: {
                    dir_path: { type: 'string', description: 'Directory path (e.g. "health", "personal", "work"). Use empty string for root.' }
                },
                required: ['dir_path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'retrieve_file',
            description: 'Search memory files by keyword. Returns paths of files whose content or path matches the query.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Keyword to search for in file contents.' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read the full content of a memory file by its path.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path to read (e.g. personal/about.md)' }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_bullet',
            description: 'PERMANENTLY delete a specific bullet from a memory file. Use ONLY for bullets that are about the target subject. This cannot be undone. Pass the EXACT bullet text as it appears in the file, including all | metadata.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path containing the bullet (e.g. personal/about.md)' },
                    bullet_text: { type: 'string', description: 'The EXACT text of the bullet to delete, as it appears in the file, including all | metadata.' }
                },
                required: ['path', 'bullet_text']
            }
        }
    }
];

/** Tools used in deep delete mode — no discovery tools needed since all paths are listed upfront. */
const DEEP_DELETION_TOOLS = DELETION_TOOLS.filter(t =>
    ['read_file', 'delete_bullet'].includes(t.function.name)
);

export class MemoryDeleter {
    /**
     * @param {{ backend: StorageBackend, bulletIndex: object, llmClient: LLMClient, model: string, onToolCall?: Function }} options
     */
    constructor({ backend, bulletIndex, llmClient, model, onToolCall }) {
        this._backend = backend;
        this._bulletIndex = bulletIndex;
        this._llmClient = llmClient;
        this._model = model;
        this._onToolCall = onToolCall || null;
    }

    /**
     * Delete memory content matching the given query.
     *
     * @param {string} query  Plain-text description of what to delete.
     * @param {{ deep?: boolean, mode?: string }} [options]
     * @returns {Promise<{ status: string, deleteCalls: number, writes: Array }>}
     */
    async deleteForQuery(query, options = {}) {
        if (!query || !query.trim()) {
            return { status: 'skipped', deleteCalls: 0, writes: [] };
        }

        const isDocument = options.mode === 'document';

        return options.deep
            ? this._deepDelete(query, isDocument)
            : this._standardDelete(query, isDocument);
    }

    async _standardDelete(query, isDocument) {
        await this._backend.init();
        const index = await this._backend.getTree() || '';

        const promptKey = isDocument ? 'document_delete' : 'delete';
        const { ingestionPrompt } = resolvePromptSet(promptKey);
        const systemPrompt = ingestionPrompt
            .replace('{QUERY}', query)
            .replace('{INDEX}', index);

        return this._runDeletionLoop(query, systemPrompt, DELETION_TOOLS, 8);
    }

    async _deepDelete(query, isDocument) {
        await this._backend.init();

        const allFiles = await this._backend.exportAll();
        const paths = allFiles
            .map(f => f.path)
            .filter(p => !p.endsWith('_tree.md'))
            .sort();

        if (paths.length === 0) {
            return { status: 'skipped', deleteCalls: 0, writes: [] };
        }

        const fileList = paths.map(p => `- ${p}`).join('\n');

        const promptKey = isDocument ? 'document_deep_delete' : 'deep_delete';
        const { ingestionPrompt } = resolvePromptSet(promptKey);
        const systemPrompt = ingestionPrompt
            .replace('{QUERY}', query)
            .replace('{FILE_LIST}', fileList);

        // Each file needs a read + potentially multiple deletes; allow enough iterations.
        const maxIterations = Math.max(30, paths.length * 3);

        return this._runDeletionLoop(query, systemPrompt, DEEP_DELETION_TOOLS, maxIterations);
    }

    async _runDeletionLoop(query, systemPrompt, tools, maxIterations) {
        const writes = [];
        const onToolCall = this._onToolCall;

        const toolExecutors = createDeletionExecutors(this._backend, {
            refreshIndex: (path) => this._bulletIndex.refreshPath(path),
            onWrite: (path, before, after) => writes.push({ path, before, after }),
        });

        try {
            await runAgenticToolLoop({
                llmClient: this._llmClient,
                model: this._model,
                tools,
                toolExecutors,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: query }
                ],
                maxIterations,
                maxOutputTokens: 2000,
                temperature: 0,
                onToolCall: (name, args, result) => {
                    onToolCall?.(name, args, result);
                }
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { status: 'error', deleteCalls: 0, writes: [], error: message };
        }

        return { status: 'processed', deleteCalls: writes.length, writes };
    }
}

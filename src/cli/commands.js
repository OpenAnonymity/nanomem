/**
 * CLI command implementations — thin wrappers around the library API.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { serialize, toZip } from '../utils/portability.js';
import { safeDateIso } from '../bullets/normalize.js';
import { extractSessionsFromOAFastchatExport } from '../imports/oaFastchat.js';
import { isChatGptExport, parseChatGptExport } from '../imports/chatgpt.js';
import { parseMarkdownFiles } from '../imports/markdown.js';
import { loginInteractive } from './auth.js';
import { writeConfigFile, CONFIG_PATH } from './config.js';
import { createSpinner } from './spinner.js';
import { printFileDiff } from './diff.js';

// ─── Helpers ─────────────────────────────────────────────────────

async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
}

async function readMarkdownDir(dirPath) {
    const entries = await readdir(dirPath, { recursive: true });
    const files = [];
    for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const fullPath = join(dirPath, entry);
        const info = await stat(fullPath);
        if (!info.isFile()) continue;
        const content = await readFile(fullPath, 'utf-8');
        files.push({ path: entry, content });
    }
    return files;
}

function buildExportPath(format) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = format === 'zip' ? 'zip' : 'txt';
    return resolve(process.cwd(), `memory-export-${stamp}.${ext}`);
}

/**
 * Parse input into one or more conversations.
 * Returns [{ title, messages }] to handle both single and multi-session inputs.
 *
 * Auto-detects:
 *   1. OA Fastchat export  → { data: { chats: { sessions, messages } } }
 *   2. ChatGPT export      → [{ mapping, current_node, title, ... }]
 *   3. JSON messages array  → [{ role, content }]
 *   4. Plain text           → User: / Assistant: line format
 */
function parseConversations(input, flags) {
    const trimmed = input.trim();

    // Try JSON
    try {
        const parsed = JSON.parse(trimmed);

        // OA Fastchat export
        if (parsed?.data?.chats?.sessions) {
            const sessions = extractSessionsFromOAFastchatExport(parsed, {
                sessionId: flags['session-id'],
                sessionTitle: flags['session-title'],
            });
            return sessions.map(s => ({
                title: s.session.title || s.session.id || 'untitled',
                messages: s.conversation,
                updatedAt: safeDateIso(s.session.updatedAt),
            }));
        }

        // ChatGPT export (conversations.json)
        if (isChatGptExport(parsed)) {
            return parseChatGptExport(parsed);
        }

        // Plain messages array
        if (Array.isArray(parsed)) {
            return [{ title: null, messages: parsed }];
        }
    } catch { /* fall through to text parsing */ }

    // Parse User: / Assistant: format
    const messages = [];
    const lines = trimmed.split('\n');
    let current = null;
    for (const line of lines) {
        const userMatch = line.match(/^User:\s*(.*)/i);
        const asstMatch = line.match(/^Assistant:\s*(.*)/i);
        if (userMatch) {
            if (current) messages.push(current);
            current = { role: 'user', content: userMatch[1] };
        } else if (asstMatch) {
            if (current) messages.push(current);
            current = { role: 'assistant', content: asstMatch[1] };
        } else if (current) {
            current.content += '\n' + line;
        }
    }
    if (current) messages.push(current);

    if (messages.length === 0) {
        // Fallback: treat as plain markdown notes to extract facts from
        return parseMarkdownFiles(trimmed);
    }
    return [{ title: null, messages }];
}

// ─── Commands ────────────────────────────────────────────────────

export async function init(positionals, flags, mem, config) {
    await mem.init();
    return { status: 'initialized', storage: config.storage, path: config.storagePath };
}

export async function retrieve(positionals, flags, mem) {
    const query = positionals[0];
    if (!query) throw new Error('Usage: memory retrieve <query>');

    await mem.init();

    let conversationText = null;
    if (flags.context) {
        conversationText = await readFile(flags.context, 'utf-8');
    }

    const result = await mem.retrieve(query, conversationText);
    if (!result || !result.assembledContext) {
        return { assembledContext: null, message: 'No relevant context found.' };
    }
    return result;
}

export async function importCmd(positionals, flags, mem, config, { showProgress, spinnerHolder } = {}) {
    const source = positionals[0];
    let conversations;
    let extractionMode = 'conversation';

    if (source === '-' || (!source && !process.stdin.isTTY)) {
        conversations = parseConversations(await readStdin(), flags);
    } else if (source) {
        const info = await stat(source);
        if (info.isDirectory()) {
            const files = await readMarkdownDir(source);
            if (files.length === 0) throw new Error(`No .md files found in ${source}`);
            conversations = parseMarkdownFiles(files);
            extractionMode = 'document';
        } else {
            conversations = parseConversations(await readFile(source, 'utf-8'), flags);
            if (flags.format === 'markdown') extractionMode = 'document';
        }
    } else {
        throw new Error('Usage: memory import <file|dir|->');
    }

    return ingestConversations(conversations, extractionMode, mem, { showProgress, spinnerHolder, status: 'imported' });
}

export async function add(positionals, flags, mem, config, { showProgress, spinnerHolder } = {}) {
    const input = positionals[0] ?? (!process.stdin.isTTY ? await readStdin() : null);
    if (!input) throw new Error('Usage: nanomem add <text>');

    const conversations = parseConversations(input, flags);
    return ingestConversations(conversations, 'add', mem, { showProgress, spinnerHolder, status: 'added', showDiff: true });
}

export async function update(positionals, flags, mem, config, { showProgress, spinnerHolder } = {}) {
    const input = positionals[0] ?? (!process.stdin.isTTY ? await readStdin() : null);
    if (!input) throw new Error('Usage: nanomem update <text>');

    const conversations = parseConversations(input, flags);
    return ingestConversations(conversations, 'update', mem, { showProgress, spinnerHolder, status: 'updated', showDiff: true });
}

async function ingestConversations(conversations, extractionMode, mem, { showProgress, spinnerHolder, status, showDiff = false }) {
    await mem.init();

    const total = conversations.length;
    let totalWriteCalls = 0;
    const results = [];

    const isTTY = process.stderr.isTTY;
    const c = isTTY ? { green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', gray: '\x1b[90m' }
                    : { green: '', yellow: '', dim: '', bold: '', reset: '', gray: '' };

    for (let i = 0; i < total; i++) {
        const conv = conversations[i];
        const label = conv.title || (total > 1 ? `conversation ${i + 1}` : 'conversation');

        if (showProgress) {
            const counter = total > 1 ? `${c.gray}(${i + 1}/${total})${c.reset} ` : '';
            process.stderr.write(`\n  ${counter}${c.bold}"${label}"${c.reset}\n`);
        }

        let spinner = null;
        if (showProgress && isTTY) {
            spinner = createSpinner('thinking…');
            if (spinnerHolder) spinnerHolder.current = spinner;
        }

        const result = await mem.ingest(conv.messages, { updatedAt: conv.updatedAt, extractionMode });

        if (spinnerHolder) spinnerHolder.current = null;
        if (showProgress) {
            if (result.status === 'error') {
                spinner?.stop(`  ${c.yellow}⚠ ${result.error}${c.reset}`);
            } else if (result.writeCalls > 0) {
                spinner?.stop(`  ${c.green}✓ ${result.writeCalls} fact${result.writeCalls === 1 ? '' : 's'} saved${c.reset}`);
            } else {
                spinner?.stop(`  ${c.dim}– nothing to save${c.reset}`);
            }
            if (showDiff && result.writes?.length) {
                for (const { path, before, after } of result.writes) {
                    printFileDiff(path, before, after);
                }
            }
        }

        totalWriteCalls += result.writeCalls || 0;
        results.push({ session: label, messages: conv.messages.length, writeCalls: result.writeCalls, error: result.error });
    }

    return { status, sessions: results.length, totalWriteCalls, details: results };
}

export async function compact(positionals, flags, mem) {
    await mem.init();
    const stats = await mem.compact();
    return { status: 'compacted', filesChanged: stats?.filesChanged ?? 0, filesTotal: stats?.filesTotal ?? 0 };
}

export async function ls(positionals, flags, mem) {
    await mem.init();
    return mem.storage.ls(positionals[0] || '');
}

export async function read(positionals, flags, mem) {
    const path = positionals[0];
    if (!path) throw new Error('Usage: memory read <path>');

    await mem.init();
    const content = await mem.storage.read(path);
    if (content == null) {
        throw new Error(`File not found: ${path}`);
    }
    return { path, content };
}

export async function write(positionals, flags, mem) {
    const path = positionals[0];
    if (!path) throw new Error('Usage: memory write <path>');

    let content;
    if (flags.content != null) {
        content = flags.content;
    } else if (!process.stdin.isTTY) {
        content = await readStdin();
    } else {
        throw new Error('Provide content via --content or stdin.');
    }

    await mem.init();
    await mem.storage.write(path, content);
    return { status: 'written', path };
}

export async function del(positionals, flags, mem) {
    const path = positionals[0];
    if (!path) throw new Error('Usage: memory delete <path>');

    await mem.init();
    await mem.storage.delete(path);
    return { status: 'deleted', path };
}

export async function search(positionals, flags, mem) {
    const query = positionals[0];
    if (!query) throw new Error('Usage: memory search <query>');

    await mem.init();
    const results = await mem.storage.search(query);
    results._query = query;
    return results;
}

export async function exportCmd(positionals, flags, mem) {
    const format = flags.format || 'txt';
    await mem.init();
    const all = await mem.storage.exportAll();
    const files = all.filter(f => !f.path.endsWith('_tree.md'));
    const exportPath = buildExportPath(format);

    if (format === 'zip') {
        const zip = toZip(all);
        await writeFile(exportPath, zip);
    } else {
        await writeFile(exportPath, serialize(all), 'utf-8');
    }

    return { status: 'exported', files: files.length, format, path: exportPath };
}



export async function clear(positionals, flags, mem, config) {
    await mem.init();
    const all = await mem.storage.exportAll();
    const files = all.filter(f => !f.path.endsWith('_tree.md'));

    if (!flags.confirm) {
        throw new Error(`This will delete ${files.length} file${files.length === 1 ? '' : 's'} in ${config.storagePath}. Run with --confirm to proceed.`);
    }

    await mem.storage.clear();
    return { status: 'cleared', filesDeleted: files.length, path: config.storagePath };
}

export async function status(positionals, flags, mem, config) {
    await mem.init();
    const all = await mem.storage.exportAll();
    const files = all.filter(f => !f.path.endsWith('_tree.md'));

    const dirs = new Set();
    for (const f of files) {
        const slash = f.path.indexOf('/');
        if (slash !== -1) dirs.add(f.path.slice(0, slash));
    }

    return {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        storage: config.storage,
        storagePath: config.storagePath,
        configFile: CONFIG_PATH,
        files: files.length,
        directories: [...dirs].sort(),
    };
}

export async function tree(positionals, flags, mem, config) {
    await mem.init();
    const all = await mem.storage.exportAll();
    const files = all
        .filter(f => !f.path.endsWith('_tree.md'))
        .sort((a, b) => a.path.localeCompare(b.path));

    if (files.length === 0) {
        return { treeLines: [] };
    }

    // Group by top-level directory
    const grouped = new Map(); // dir → [file]
    for (const f of files) {
        const slash = f.path.indexOf('/');
        const dir = slash !== -1 ? f.path.slice(0, slash) : '';
        const name = slash !== -1 ? f.path.slice(slash + 1) : f.path;
        if (!grouped.has(dir)) grouped.set(dir, []);
        grouped.get(dir).push({ ...f, name });
    }

    const isTTY = process.stdout.isTTY;
    const c = isTTY ? {
        reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
        cyan: '\x1b[36m', green: '\x1b[32m', gray: '\x1b[90m', yellow: '\x1b[33m',
    } : Object.fromEntries(['reset','bold','dim','cyan','green','gray','yellow'].map(k => [k, '']));

    const lines = [];
    lines.push('');
    lines.push(`  ${c.bold}Memory${c.reset}  ${c.dim}${config.storagePath}${c.reset}`);
    lines.push('');

    const dirs = [...grouped.keys()].sort();
    for (const dir of dirs) {
        const entries = grouped.get(dir);

        if (dir) {
            lines.push(`  ${c.cyan}${dir}/${c.reset}`);
        }

        const prefix = dir ? '  ' : '';
        for (let i = 0; i < entries.length; i++) {
            const f = entries[i];
            const isLast = i === entries.length - 1;
            const branch = entries.length === 1 ? '──' : isLast ? '└─' : '├─';
            const count = f.itemCount != null ? `${c.green}${String(f.itemCount).padStart(3)} facts${c.reset}` : '';
            const hint  = f.oneLiner ? `  ${c.dim}${f.oneLiner.slice(0, 60)}${f.oneLiner.length > 60 ? '…' : ''}${c.reset}` : '';
            const fname = f.name.replace(/\.md$/, '');
            lines.push(`  ${prefix}${c.gray}${branch}${c.reset} ${c.bold}${fname}${c.reset}  ${count}${hint}`);
        }
        lines.push('');
    }

    const totalFacts = files.reduce((n, f) => n + (f.itemCount || 0), 0);
    lines.push(`  ${c.dim}${files.length} file${files.length === 1 ? '' : 's'}  ·  ${totalFacts} facts total${c.reset}`);
    lines.push('');

    return { treeLines: lines };
}

export async function login(positionals, flags, mem, config) {
    // Non-interactive mode: --api-key provided as a flag
    if (flags['api-key']) {
        const toSave = {
            provider: flags.provider || config.provider,
            apiKey: flags['api-key'],
            storage: flags.storage || (flags.path ? 'filesystem' : null) || config.storage || 'filesystem',
        };
        if (flags.model) toSave.model = flags.model;
        if (flags.path)  toSave.storagePath = flags.path;
        await writeConfigFile(toSave);
        return { status: 'logged_in', provider: toSave.provider, configFile: CONFIG_PATH };
    }

    return loginInteractive();
}

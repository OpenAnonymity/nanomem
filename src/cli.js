#!/usr/bin/env node
/**
 * CLI entry point for @openanonymity/memory.
 *
 * Usage: memory <command> [args] [flags]
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveConfig, createMemoryFromConfig } from './cli/config.js';
import { GLOBAL_HELP, COMMAND_HELP } from './cli/help.js';
import { formatOutput } from './cli/output.js';
import * as commands from './cli/commands.js';

// ─── Parse args ──────────────────────────────────────────────────

const OPTIONS = {
    'api-key':       { type: 'string' },
    'model':         { type: 'string' },
    'provider':      { type: 'string' },
    'base-url':      { type: 'string' },
    'storage':       { type: 'string' },
    'path':          { type: 'string' },
    'json':          { type: 'boolean', default: false },
    'help':          { type: 'boolean', short: 'h', default: false },
    'version':       { type: 'boolean', short: 'v', default: false },
    'content':       { type: 'string' },
    'format':        { type: 'string' },
    'context':       { type: 'string' },
    'session-id':    { type: 'string' },
    'session-title': { type: 'string' },
    'confirm':       { type: 'boolean', default: false },
};

const COMMAND_MAP = {
    init:     commands.init,
    retrieve: commands.retrieve,
    import:   commands.importCmd,
    compact:  commands.compact,
    ls:       commands.ls,
    read:     commands.read,
    write:    commands.write,
    delete:   commands.del,
    search:   commands.search,
    export:   commands.exportCmd,
    clear:    commands.clear,
    status:   commands.status,
};

// ─── Main ────────────────────────────────────────────────────────

async function main() {
    let values, positionals;
    try {
        ({ values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true }));
    } catch (err) {
        die(err.message);
    }

    // --version
    if (values.version) {
        const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
        console.log(pkg.version);
        return;
    }

    const commandName = positionals[0];
    const commandArgs = positionals.slice(1);

    // --help (global or per-command)
    if (values.help || !commandName) {
        if (commandName && COMMAND_HELP[commandName]) {
            console.log(COMMAND_HELP[commandName]);
        } else {
            console.log(GLOBAL_HELP);
        }
        return;
    }

    const handler = COMMAND_MAP[commandName];
    if (!handler) {
        die(`Unknown command: ${commandName}\n\n${GLOBAL_HELP}`);
    }

    const config = resolveConfig(values);
    const memOpts = {};

    // Wire progress for import/extract — show tool calls in real-time
    const isImport = commandName === 'import' || commandName === 'extract';
    const showProgress = isImport && !values.json && process.stderr.isTTY;
    if (showProgress) {
        memOpts.onToolCall = (name) => {
            const TOOL_LABELS = {
                create_new_file: 'creating file',
                append_memory: 'writing memory',
                update_memory: 'updating memory',
                archive_memory: 'archiving',
                delete_memory: 'cleaning up',
                read_file: 'reading',
                list_files: 'scanning',
            };
            const label = TOOL_LABELS[name] || name;
            process.stderr.write(`  \u2192 ${label}\n`);
        };
    }

    const mem = createMemoryFromConfig(config, commandName, memOpts);
    const result = await handler(commandArgs, values, mem, config, { showProgress });

    if (result != null) {
        const output = formatOutput(result, values);
        if (output) console.log(output);
    }
}

function die(message) {
    console.error(message);
    process.exit(1);
}

main().catch(err => {
    die(err.message || String(err));
});

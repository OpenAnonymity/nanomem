#!/usr/bin/env node
/**
 * CLI entry point for @openanonymity/nanomem.
 *
 * Usage: nanomem <command> [args] [flags]
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveConfig, createMemoryFromConfig } from './cli/config.js';
import { GLOBAL_HELP, COMMAND_HELP } from './cli/help.js';
import { formatOutput } from './cli/output.js';
import { createSpinner } from './cli/spinner.js';
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
    'render':        { type: 'boolean', default: false },
    'deep':          { type: 'boolean', default: false },
};

const COMMAND_MAP = {
    add:      commands.add,
    update:   commands.update,
    login:    commands.login,
    init:     commands.init,
    retrieve: commands.retrieve,
    import:   commands.importCmd,
    compact:  commands.compact,
    tree:     commands.tree,
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

    const config = await resolveConfig(values);
    const memOpts = {};

    // Wire progress for import/extract — spinner per session with live tool call updates
    const isImport = commandName === 'import' || commandName === 'add' || commandName === 'update' || commandName === 'extract' || commandName === 'delete';
    const showProgress = isImport && !values.json && process.stderr.isTTY;
    const spinnerHolder = { current: null }; // shared mutable ref between onToolCall and import loop
    if (showProgress) {
        const TOOL_LABELS = {
            create_new_file: 'creating file',
            append_memory:   'appending',
            update_memory:   'updating',
            archive_memory:  'archiving',
            delete_memory:   'cleaning up',
            read_file:       'reading',
            list_files:      'scanning',
            delete_bullet:   'deleting',
        };
        memOpts.onToolCall = (name) => {
            const label = TOOL_LABELS[name] || name;
            spinnerHolder.current?.update(label + '…');
        };
    }

    // Wire progress for retrieve — surface fallback warnings to the user
    if (commandName === 'retrieve' && !values.json && process.stderr.isTTY) {
        memOpts.onProgress = ({ stage, message }) => {
            if (stage === 'fallback') {
                process.stderr.write(`Warning: ${message}\n`);
            }
        };
    }

    if (commandName === 'compact' && !values.json && process.stderr.isTTY) {
        const cc = {
            reset: '\x1b[0m', dim: '\x1b[2m',
            yellow: '\x1b[33m', gray: '\x1b[90m',
        };
        let activeSpinner = null;
        process.stderr.write('\n');
        memOpts.onCompactProgress = ({ stage, file, current, total, deduplicated, superseded, expired }) => {
            if (stage === 'file') {
                activeSpinner = createSpinner(`${cc.dim}(${current}/${total})${cc.reset} ${file}`);
            } else if (stage === 'semantic') {
                activeSpinner?.update(`reviewing working facts… ${cc.dim}${file}${cc.reset}`);
            } else if (stage === 'file_done') {
                const changes = [];
                if (superseded   > 0) changes.push(`${superseded} superseded`);
                if (deduplicated > 0) changes.push(`${deduplicated} deduplicated`);
                if (expired      > 0) changes.push(`${expired} expired`);
                const tag = changes.length > 0
                    ? `${cc.yellow}${changes.join(', ')}${cc.reset}`
                    : `${cc.dim}no changes${cc.reset}`;
                activeSpinner?.stop(`  ${cc.gray}${file.padEnd(36)}${cc.reset}  ${tag}`);
                activeSpinner = null;
            }
        };
    }

    const mem = createMemoryFromConfig(config, commandName, memOpts);

    // Spinner for operations that give no other feedback
    const useSpinner = !values.json && process.stderr.isTTY &&
        (commandName === 'retrieve' || commandName === 'compact');
    const spinner = useSpinner && commandName === 'retrieve'
        ? createSpinner('searching memory…')
        : null;

    const result = await handler(commandArgs, values, mem, config, { showProgress, spinnerHolder });

    spinner?.stop();

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

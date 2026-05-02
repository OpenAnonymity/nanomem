/**
 * Interactive authentication for `memory login`.
 *
 * All providers: API key paste
 */

import { writeConfigFile, CONFIG_PATH, DEFAULT_STORAGE_PATH } from './config.js';

// ─── ANSI helpers ────────────────────────────────────────────────

const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
};

// ─── Provider / model definitions ────────────────────────────────

const PROVIDERS = [
    { value: 'openai',      label: 'OpenAI',           desc: 'GPT-5.4 and variants' },
    { value: 'anthropic',   label: 'Anthropic',        desc: 'Claude Sonnet & Opus' },
    { value: 'tinfoil',     label: 'Tinfoil',          desc: 'Kimi, GPT-OSS, DeepSeek and more' },
    { value: 'openrouter',  label: 'OpenRouter',       desc: 'Access 300+ models via one API' },
    { value: 'custom',      label: 'Custom endpoint',  desc: 'Any OpenAI-compatible API' },
];

const MODELS = {
    openai: [
        { value: 'gpt-5.4-nano', label: 'gpt-5.4-nano', desc: 'Fastest, lowest cost' },
        { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini', desc: 'Fast & affordable' },
        { value: 'gpt-5.4', label: 'gpt-5.4', desc: 'Most capable' },
    ],
    anthropic: [
        { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', desc: 'Balanced speed & quality' },
        { value: 'claude-opus-4-6', label: 'claude-opus-4-6', desc: 'Most capable' },
    ],
    tinfoil: [
        { value: 'kimi-k2-6',        label: 'kimi-k2-6',        desc: 'Kimi K2.6' },
        { value: 'gpt-oss-120b',     label: 'gpt-oss-120b',     desc: 'Open-source GPT 120B' },
        { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro', desc: 'DeepSeek V4 Pro' },
        { value: 'gemma4-31b', label: 'gemma4-31b', desc: 'Gemma4 31B' },
    ],
    openrouter: [
        { value: 'anthropic/claude-sonnet-4.6', label: 'anthropic/claude-sonnet-4.6', desc: 'Claude Sonnet 4.6 via OpenRouter' },
        { value: 'anthropic/claude-opus-4.7', label: 'anthropic/claude-opus-4.7', desc: 'Claude Opus 4.7 via OpenRouter' },
        { value: 'google/gemini-3-flash-preview', label: 'google/gemini-3-flash-preview', desc: 'Gemini 3 Flash Preview via OpenRouter' },
        { value: 'moonshotai/kimi-k2.6', label: 'moonshotai/kimi-k2.6', desc: 'Kimi K2.6 via OpenRouter' },
        { value: 'deepseek/deepseek-v3.2', label: 'deepseek/deepseek-v3.2', desc: 'DeepSeek V3.2 via OpenRouter' },
    ],
};

// ─── Main entry point ────────────────────────────────────────────

export async function loginInteractive() {
    // Header
    process.stderr.write('\n');
    process.stderr.write(`  ${c.bold}${c.cyan}Login${c.reset}\n`);
    process.stderr.write('\n');
    process.stderr.write(`  ${c.white}nanomem uses an LLM provider for extraction and retrieval.${c.reset}\n`);
    process.stderr.write(`  ${c.white}Select your provider, model, and paste your API key to get started.${c.reset}\n`);
    process.stderr.write('\n');

    // Step 1: Provider
    process.stderr.write(`  ${c.dim}Select provider:${c.reset}\n`);
    process.stderr.write('\n');
    const provider = await promptSelect(PROVIDERS);

    // Step 2: Base URL (custom endpoint only)
    let baseUrl;
    if (provider === 'custom') {
        baseUrl = await promptText('Base URL (OpenAI-compatible)');
    }

    // Step 3: Model
    let model;
    if (provider === 'custom') {
        model = await promptText('Model name');
    } else {
        const modelChoices = [
            ...MODELS[provider],
            { value: '__custom__', label: 'Custom', desc: 'Enter a model name manually' },
        ];
        process.stderr.write('\n');
        process.stderr.write(`  ${c.dim}Select model:${c.reset}\n`);
        process.stderr.write('\n');
        const modelSelection = await promptSelect(modelChoices);
        if (modelSelection === '__custom__') {
            model = await promptText('Model name');
        } else {
            model = modelSelection;
        }
    }

    // Step 4: API key
    const labels = { openai: 'OpenAI', anthropic: 'Anthropic', tinfoil: 'Tinfoil', openrouter: 'OpenRouter', custom: 'API' };
    const apiKey = await promptSecret(`${labels[provider]} key`);

    // Step 5: Storage path
    const defaultPath = DEFAULT_STORAGE_PATH;
    const pathChoices = [
        { value: defaultPath, label: defaultPath, desc: 'Default' },
        { value: '__custom__', label: 'Custom', desc: 'Enter a path' },
    ];
    process.stderr.write('\n');
    process.stderr.write(`  ${c.dim}Memory storage path:${c.reset}\n`);
    process.stderr.write('\n');
    let storagePath;
    const pathSelection = await promptSelect(pathChoices);
    if (pathSelection === '__custom__') {
        storagePath = await promptText('Storage path');
    } else {
        storagePath = pathSelection;
    }

    const toSave = { provider, apiKey, model, storage: 'filesystem', storagePath };
    if (baseUrl) toSave.baseUrl = baseUrl;

    await writeConfigFile(toSave);

    const displayProvider = provider === 'custom' ? baseUrl : labels[provider];
    process.stderr.write('\n');
    process.stderr.write(`  ${c.green}✔${c.reset} ${c.bold}Logged in${c.reset} ${c.dim}·${c.reset} ${displayProvider} ${c.dim}·${c.reset} ${model}\n`);
    process.stderr.write(`  ${c.dim}Config saved to ${CONFIG_PATH}${c.reset}\n`);
    process.stderr.write('\n');

    return { status: 'logged_in_interactive', provider, model };
}

// ─── Numbered select with arrow keys ─────────────────────────────

function promptSelect(options) {
    if (!process.stdin.isTTY) {
        throw new Error('Selection requires an interactive terminal.');
    }

    return new Promise(resolve => {
        let idx = 0;

        drawOptions(options, idx);

        const { stdin } = process;
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf-8');

        function cleanup() {
            stdin.setRawMode(wasRaw);
            stdin.pause();
            stdin.removeListener('data', onData);
        }

        function onData(data) {
            switch (data) {
                case '\u0003': // Ctrl-C
                    cleanup();
                    process.stderr.write('\n');
                    process.exit(1);
                    break;
                case '\x1b[A': case 'k': // Up
                    idx = (idx - 1 + options.length) % options.length;
                    redrawOptions(options, idx);
                    break;
                case '\x1b[B': case 'j': // Down
                    idx = (idx + 1) % options.length;
                    redrawOptions(options, idx);
                    break;
                case '\r': case '\n': { // Enter
                    cleanup();
                    const opt = options[idx];
                    // Collapse to single selected line
                    process.stderr.write(`\x1b[${options.length}A`);
                    process.stderr.write(`\r\x1b[2K  ${c.green}❯${c.reset} ${c.bold}${opt.label}${c.reset} ${c.dim}· ${opt.desc}${c.reset}\n`);
                    for (let i = 1; i < options.length; i++) {
                        process.stderr.write('\x1b[2K\n');
                    }
                    // Move cursor back up to remove blank lines
                    if (options.length > 1) {
                        process.stderr.write(`\x1b[${options.length - 1}A`);
                    }
                    resolve(opt.value);
                    break;
                }
            }
        }

        stdin.on('data', onData);
    });
}

function drawOptions(options, selected) {
    for (let i = 0; i < options.length; i++) {
        const isSelected = i === selected;
        const num = `${i + 1}.`;
        if (isSelected) {
            process.stderr.write(`  ${c.cyan}❯ ${num}${c.reset} ${c.white}${c.bold}${options[i].label}${c.reset} ${c.dim}· ${options[i].desc}${c.reset}\n`);
        } else {
            process.stderr.write(`    ${c.dim}${num}${c.reset} ${c.gray}${options[i].label} ${c.dim}· ${options[i].desc}${c.reset}\n`);
        }
    }
}

function redrawOptions(options, selected) {
    process.stderr.write(`\x1b[${options.length}A`);
    drawOptions(options, selected);
}

// ─── Text input ──────────────────────────────────────────────────

function promptText(label) {
    if (!process.stdin.isTTY) {
        throw new Error(`${label} input requires an interactive terminal.`);
    }

    return new Promise((resolve, reject) => {
        process.stderr.write(`\n  ${c.cyan}?${c.reset} ${label}: `);

        const { stdin } = process;
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf-8');

        let value = '';

        function cleanup() {
            stdin.setRawMode(wasRaw);
            stdin.pause();
            stdin.removeListener('data', onData);
        }

        function onData(char) {
            switch (char) {
                case '\r': case '\n':
                    cleanup();
                    process.stderr.write('\n');
                    if (!value) reject(new Error(`No ${label.toLowerCase()} entered.`));
                    else resolve(value);
                    break;
                case '\u0003':
                    cleanup();
                    process.stderr.write('\n');
                    process.exit(1);
                    break;
                case '\u007f': case '\b':
                    if (value.length > 0) {
                        value = value.slice(0, -1);
                        process.stderr.write('\b \b');
                    }
                    break;
                default:
                    if (char >= ' ') {
                        value += char;
                        process.stderr.write(char);
                    }
            }
        }

        stdin.on('data', onData);
    });
}

// ─── Masked secret input ─────────────────────────────────────────

function promptSecret(label) {
    if (!process.stdin.isTTY) {
        throw new Error('API key input requires an interactive terminal. Use --api-key instead.');
    }

    return new Promise((resolve, reject) => {
        process.stderr.write(`\n  ${c.cyan}?${c.reset} ${label}: `);

        const { stdin } = process;
        if (!stdin.isTTY) return reject(new Error('Not a TTY'));

        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf-8');

        let value = '';

        function cleanup() {
            stdin.setRawMode(wasRaw);
            stdin.pause();
            stdin.removeListener('data', onData);
        }

        function onData(char) {
            switch (char) {
                case '\r': case '\n':
                    cleanup();
                    process.stderr.write('\n');
                    if (!value) reject(new Error('No key entered.'));
                    else resolve(value);
                    break;
                case '\u0003':
                    cleanup();
                    process.stderr.write('\n');
                    process.exit(1);
                    break;
                case '\u007f': case '\b':
                    if (value.length > 0) {
                        value = value.slice(0, -1);
                        process.stderr.write('\b \b');
                    }
                    break;
                default:
                    if (char >= ' ') {
                        value += char;
                        process.stderr.write('*');
                    }
            }
        }

        stdin.on('data', onData);
    });
}

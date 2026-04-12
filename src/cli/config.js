/**
 * CLI config resolution — flags + config file + env vars → createMemoryBank config.
 *
 * Config lives at ~/.config/nanomem/config.json (fixed location).
 * Memory data lives at ~/nanomem by default (configurable via login or --path).
 *
 * Priority (highest wins):
 *   CLI flags  >  config file  >  env vars  >  preset defaults
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createMemoryBank } from '../index.js';

// ─── Paths ──────────────────────────────────────────────────────

export const CONFIG_DIR = join(homedir(), '.config', 'nanomem');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const DEFAULT_STORAGE_PATH = join(homedir(), 'nanomem');

// ─── Config file ────────────────────────────────────────────────

export async function readConfigFile() {
    try {
        const raw = await readFile(CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

export async function writeConfigFile(data) {
    await mkdir(CONFIG_DIR, { recursive: true });
    const existing = await readConfigFile();
    const merged = { ...existing, ...data };
    await writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

// ─── Provider presets ───────────────────────────────────────────

const PRESETS = {
    tinfoil: { envKey: 'TINFOIL_API_KEY', baseUrl: 'https://inference.tinfoil.sh/v1', model: 'kimi-k2-5' },
    openai: { envKey: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
    anthropic: { envKey: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-6', isAnthropic: true },
    openrouter: {
        envKey: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o',
        headers: { 'HTTP-Referer': 'https://github.com/openanonymity/nanomem', 'X-Title': 'nanomem' }
    },
    custom: { envKey: null, baseUrl: null, model: null },
};

// ─── Resolve config ─────────────────────────────────────────────

export async function resolveConfig(flags) {
    const fileConfig = await readConfigFile();

    // 1. Pick provider
    let providerName = flags.provider || fileConfig.provider || process.env.LLM_PROVIDER || null;
    let preset;
    if (providerName) {
        preset = PRESETS[providerName];
        if (!preset) {
            throw new Error(`Unknown provider: ${providerName}. Use: ${Object.keys(PRESETS).join(', ')}`);
        }
    } else {
        const match = Object.entries(PRESETS).find(([, p]) => p.envKey && process.env[p.envKey]);
        providerName = match ? match[0] : 'openai';
        preset = match ? match[1] : PRESETS.openai;
    }

    // 2. Resolve fields — flags > config file > env vars > preset defaults
    const apiKey = flags['api-key'] || fileConfig.apiKey || process.env.LLM_API_KEY || (preset.envKey && process.env[preset.envKey]) || null;
    const baseUrl = flags['base-url'] || fileConfig.baseUrl || process.env.LLM_BASE_URL || preset.baseUrl;
    const model = flags.model || fileConfig.model || process.env.LLM_MODEL || preset.model;
    const headers = preset.headers || null;
    const storage = flags.storage || (flags.path ? 'filesystem' : null) || fileConfig.storage || 'filesystem';
    const rawPath = flags.path || fileConfig.storagePath || DEFAULT_STORAGE_PATH;
    const storagePath = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath;

    return { apiKey, baseUrl, model, headers, provider: providerName, isAnthropic: !!preset.isAnthropic, storage, storagePath };
}

// ─── Create a memory instance from resolved config ──────────────

const LLM_COMMANDS = new Set(['retrieve', 'extract', 'compact', 'import', 'add', 'update', 'delete']);

export function createMemoryFromConfig(config, command, { onToolCall, onProgress, onCompactProgress } = {}) {
    const needsLlm = LLM_COMMANDS.has(command);

    if (needsLlm && !config.apiKey) {
        throw new Error(
            'No API key configured. Run `memory login` to get started.'
        );
    }

    const opts = {
        storage: config.storage,
        storagePath: config.storagePath,
    };

    if (needsLlm) {
        opts.llm = {
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            model: config.model,
            provider: config.isAnthropic ? 'anthropic' : config.provider,
            ...(config.headers ? { headers: config.headers } : {}),
        };
        if (onToolCall) opts.onToolCall = onToolCall;
        if (onProgress) opts.onProgress = onProgress;
        if (onCompactProgress) opts.onCompactProgress = onCompactProgress;
    } else {
        opts.llmClient = {
            createChatCompletion() { throw new Error('This command requires an API key.'); },
        };
    }

    return createMemoryBank(opts);
}

/**
 * CLI config resolution — env vars + flags → createMemory config.
 *
 * Priority (highest wins):
 *   CLI flags  >  LLM_* env vars  >  provider-specific env vars  >  preset defaults
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../index.js';

// ─── Provider presets ────────────────────────────────────────────

const PRESETS = {
    tinfoil:   { envKey: 'TINFOIL_API_KEY',   baseUrl: 'https://inference.tinfoil.sh/v1', model: 'kimi-k2-5' },
    openai:    { envKey: 'OPENAI_API_KEY',     baseUrl: 'https://api.openai.com/v1',       model: 'gpt-4o' },
    anthropic: { envKey: 'ANTHROPIC_API_KEY',  baseUrl: 'https://api.anthropic.com',       model: 'claude-sonnet-4-6', provider: 'anthropic' },
};

// ─── Resolve config from flags + env ─────────────────────────────

export function resolveConfig(flags) {
    // 1. Pick provider
    let providerName = flags.provider || process.env.LLM_PROVIDER || null;
    let preset;
    if (providerName) {
        preset = PRESETS[providerName];
        if (!preset) {
            throw new Error(`Unknown provider: ${providerName}. Use: ${Object.keys(PRESETS).join(', ')}`);
        }
    } else {
        // Auto-detect from env vars
        const match = Object.entries(PRESETS).find(([, p]) => process.env[p.envKey]);
        providerName = match ? match[0] : 'openai';
        preset = match ? match[1] : PRESETS.openai;
    }

    // 2. Resolve each field
    const apiKey   = flags['api-key'] || process.env.LLM_API_KEY || process.env[preset.envKey] || null;
    const baseUrl  = flags['base-url'] || process.env.LLM_BASE_URL || preset.baseUrl;
    const model    = flags.model || process.env.LLM_MODEL || preset.model;
    const provider = providerName;

    // 3. Storage
    const storage     = flags.storage || 'filesystem';
    const storagePath = flags.path || join(homedir(), '.memory');

    return { apiKey, baseUrl, model, provider, llmProvider: preset.provider, storage, storagePath };
}

// ─── Create a memory instance from resolved config ───────────────

const LLM_COMMANDS = new Set(['retrieve', 'extract', 'compact', 'import']);

export function createMemoryFromConfig(config, command, { onToolCall } = {}) {
    const needsLlm = LLM_COMMANDS.has(command);

    if (needsLlm && !config.apiKey) {
        throw new Error(
            'No API key found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, TINFOIL_API_KEY, or use --api-key.'
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
            provider: config.llmProvider,
        };
        if (onToolCall) opts.onToolCall = onToolCall;
    } else {
        // Stub client so createMemory() doesn't throw on missing apiKey
        opts.llmClient = {
            createChatCompletion() { throw new Error('This command requires an API key.'); },
        };
    }

    return createMemory(opts);
}

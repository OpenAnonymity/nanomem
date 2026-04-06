#!/usr/bin/env node
/**
 * Smoke test — exercises extract → retrieve → compact with a real LLM.
 *
 * Usage:
 *   # OpenAI
 *   OPENAI_API_KEY=sk-... node test-smoke.mjs
 *
 *   # Tinfoil (default if TINFOIL_API_KEY is set)
 *   TINFOIL_API_KEY=... node test-smoke.mjs
 *
 *   # Anthropic
 *   ANTHROPIC_API_KEY=sk-ant-... LLM_PROVIDER=anthropic LLM_MODEL=claude-sonnet-4-6 node test-smoke.mjs
 */

import { createMemoryBank } from './src/index.js';
import { safeDateIso } from './src/bullets/normalize.js';
import { readFile } from 'node:fs/promises';
import { extractSessionsFromOAFastchatExport } from './src/imports/oaFastchat.js';

// ─── Config from env / CLI flag ──────────────────────────────
// Usage:
//   node test-smoke.mjs                    (auto-detect from env vars)
//   node test-smoke.mjs --provider tinfoil
//   node test-smoke.mjs --provider openai
//   node test-smoke.mjs --provider anthropic

const PRESETS = {
    tinfoil:   { envKey: 'TINFOIL_API_KEY',   baseUrl: 'https://inference.tinfoil.sh/v1', model: 'kimi-k2-5' },
    openai:    { envKey: 'OPENAI_API_KEY',     baseUrl: 'https://api.openai.com/v1',       model: 'gpt-4o' },
    anthropic: { envKey: 'ANTHROPIC_API_KEY',  baseUrl: 'https://api.anthropic.com',       model: 'claude-sonnet-4-6', provider: 'anthropic' },
};

// CLI flags:
//   --provider <name>
//   --storage <memory|filesystem>
//   --path <dir>
//   --conversation-json <path>
//   --session-id <id>
//   --session-title <title>
function getFlag(name) {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 ? process.argv[idx + 1] : null;
}

const flagValue = getFlag('provider');
const storageFlag = getFlag('storage') || 'memory';
const storagePath = getFlag('path') || '/tmp/memory-smoke-test';
const conversationJsonPath = getFlag('conversation-json');
const sessionId = getFlag('session-id');
const sessionTitle = getFlag('session-title');

let selected;
if (flagValue) {
    selected = PRESETS[flagValue];
    if (!selected) {
        console.error(`Unknown provider: ${flagValue}. Use: ${Object.keys(PRESETS).join(', ')}`);
        process.exit(1);
    }
} else {
    // Auto-detect: first env var that's set
    selected = Object.values(PRESETS).find(p => process.env[p.envKey]);
}

if (!selected) {
    console.error(`Set one of: ${Object.values(PRESETS).map(p => p.envKey).join(', ')}, or use --provider <name> with LLM_API_KEY`);
    process.exit(1);
}

const apiKey   = process.env.LLM_API_KEY || process.env[selected.envKey];
const baseUrl  = process.env.LLM_BASE_URL  || selected.baseUrl;
const model    = process.env.LLM_MODEL     || selected.model;
const provider = process.env.LLM_PROVIDER  || selected.provider || undefined;

if (!apiKey) {
    console.error(`No API key found. Set ${selected.envKey} or LLM_API_KEY`);
    process.exit(1);
}

console.log(`Using model=${model}, baseUrl=${baseUrl}, storage=${storageFlag}${storageFlag === 'filesystem' ? ` (${storagePath})` : ''}`);

// ─── Create memory ───────────────────────────────────────────

const memory = createMemoryBank({
    llm: { apiKey, baseUrl, model, provider },
    storage: storageFlag,
    storagePath,
    onToolCall: (name, args) => console.log(`  tool: ${name}`, JSON.stringify(args).slice(0, 120)),
    onProgress: (p) => {
        if (p.stage === 'tool_call') console.log(`  tool: ${p.tool}`, JSON.stringify(p.args || {}).slice(0, 100));
    },
});

await memory.init();

// ─── Step 1: Extract facts from a conversation ──────────────

console.log('\n--- EXTRACT ---');
const fallbackConversation = [
    { role: 'user', content: "I'm allergic to peanuts and shellfish. I live in San Francisco and work as a software engineer at a startup called Acme." },
    { role: 'assistant', content: "Thanks for sharing! I'll keep in mind your peanut and shellfish allergies. SF is a great city for software engineers — how's the work at Acme going?" },
    { role: 'user', content: "It's great! I'm leading the backend team. We use TypeScript and PostgreSQL. I also have a cat named Mochi. I'm currently preparing for a product launch next month." },
    { role: 'assistant', content: "That sounds like a solid tech stack! And Mochi is an adorable name for a cat. What kind of cat is Mochi?" },
];

let conversations = [{ session: { title: 'fallback' }, conversation: fallbackConversation }];
if (conversationJsonPath) {
    const raw = await readFile(conversationJsonPath, 'utf8');
    const exportJson = JSON.parse(raw);
    conversations = extractSessionsFromOAFastchatExport(exportJson, { sessionId, sessionTitle });
    const totalMessages = conversations.reduce((sum, entry) => sum + entry.conversation.length, 0);
    console.log(`Loaded ${totalMessages} messages from ${conversations.length} session(s)`);
}

let totalWriteCalls = 0;
for (const entry of conversations) {
    console.log(`\nSession: "${entry.session.title || entry.session.id || 'untitled'}" (${entry.conversation.length} messages)`);
    const sessionDate = safeDateIso(entry.session?.updatedAt);
    const extractResult = await memory.ingest(entry.conversation, { updatedAt: sessionDate });
    totalWriteCalls += extractResult.writeCalls;
    console.log(`  Extract result: status=${extractResult.status}, writeCalls=${extractResult.writeCalls}${extractResult.error ? `, error=${extractResult.error}` : ''}`);
}
console.log(`Total writeCalls=${totalWriteCalls}`);

// ─── Step 2: Inspect what was saved ─────────────────────────

console.log('\n--- STORED FILES ---');
const allFiles = await memory.storage.exportAll();
for (const f of allFiles) {
    if (f.path === '_tree.md') continue;
    const preview = (f.content || '').split('\n').filter(l => l.trim().startsWith('-')).slice(0, 3).join('\n  ');
    if (preview) console.log(`${f.path}:\n  ${preview}`);
}

// ─── Step 3: Retrieve context for queries ───────────────────

console.log('\n--- RETRIEVE ---');
const queries = [
    'What food allergies do I have?',
    'Tell me about my pet',
    'What tech stack do I use at work?',
];

for (const query of queries) {
    console.log(`\nQuery: "${query}"`);
    const result = await memory.retrieve(query);
    if (result?.assembledContext) {
        const lines = result.assembledContext.split('\n').filter(l => l.trim()).slice(0, 5);
        console.log(`  Context (${result.paths.length} files):`);
        for (const line of lines) console.log(`    ${line}`);
    } else {
        console.log('  No context retrieved');
    }
}

// ─── Step 4: Compact ────────────────────────────────────────

console.log('\n--- COMPACT ---');
await memory.compact();
console.log('Compaction complete');

// Show final state
console.log('\n--- FINAL STATE ---');
const finalFiles = await memory.storage.exportAll();
for (const f of finalFiles) {
    if (f.path === '_tree.md') continue;
    if (!f.content?.trim()) continue;
    console.log(`\n${f.path}:`);
    console.log(f.content.trim().split('\n').map(l => `  ${l}`).join('\n'));
}

console.log('\n✓ Smoke test complete');

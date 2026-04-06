#!/usr/bin/env node
/**
 * Visual test for serialize() / deserialize().
 * No LLM required — seeds memory with hardcoded records and shows the output.
 *
 * Usage:
 *   node test-portability-visual.mjs
 */

import { createMemoryBank } from './src/index.js';
import { deserialize } from './src/utils/portability.js';

// ─── Seed memory with some hardcoded records ─────────────────

const memory = createMemoryBank({ storage: 'ram', llmClient: { createChatCompletion: () => {} } });
await memory.init();

await memory.storage.write('profile/identity.md', [
    '- name: Alice | topic=identity | tier=long_term | source=user_statement | confidence=high | updated_at=2026-03-27',
    '- lives in San Francisco | topic=identity | tier=long_term | source=user_statement | confidence=high | updated_at=2026-03-27',
    '- works as a software engineer at Acme | topic=work | tier=long_term | source=user_statement | confidence=high | updated_at=2026-03-27',
].join('\n'));

await memory.storage.write('health/allergies.md', [
    '- allergic to peanuts | topic=health | tier=long_term | source=user_statement | confidence=high | updated_at=2026-03-27',
    '- allergic to shellfish | topic=health | tier=long_term | source=user_statement | confidence=high | updated_at=2026-03-27',
].join('\n'));

await memory.storage.write('personal/pets.md', [
    '- has a cat named Mochi | topic=pets | tier=long_term | source=user_statement | confidence=high | updated_at=2026-03-27',
].join('\n'));

await memory.storage.write('work/tech-stack.md', [
    '- uses TypeScript at work | topic=work | tier=long_term | source=user_statement | confidence=high | updated_at=2026-03-27',
    '- uses PostgreSQL at work | topic=work | tier=long_term | source=user_statement | confidence=high | updated_at=2026-03-27',
    '- leads the backend team at Acme | topic=work | tier=working | source=user_statement | confidence=high | updated_at=2026-03-27',
].join('\n'));

// ─── Serialize ───────────────────────────────────────────────

console.log('=== SERIALIZE OUTPUT ===\n');
const serialized = await memory.serialize();
console.log(serialized);

// ─── Deserialize ─────────────────────────────────────────────

console.log('\n=== DESERIALIZE OUTPUT ===\n');
const records = deserialize(serialized);
for (const { path, content } of records) {
    console.log(`path: ${path}`);
    for (const line of content.split('\n').filter(l => l.trim())) {
        console.log(`  ${line}`);
    }
    console.log();
}

// ─── Round-trip check ────────────────────────────────────────

console.log('=== ROUND-TRIP CHECK ===\n');
const original = await memory.storage.exportAll();
const originalPaths = original.map(r => r.path).filter(p => !p.endsWith('_tree.md')).sort();
const deserializedPaths = records.map(r => r.path).sort();

let allMatch = true;
for (const path of originalPaths) {
    const orig = original.find(r => r.path === path)?.content ?? '';
    const restored = records.find(r => r.path === path)?.content ?? '';
    const match = orig === restored;
    if (!match) allMatch = false;
    console.log(`${match ? '✓' : '✗'} ${path}`);
}

const pathsMatch = JSON.stringify(originalPaths) === JSON.stringify(deserializedPaths);
if (!pathsMatch) {
    allMatch = false;
    console.log(`\n✗ path sets differ`);
    console.log(`  original:     ${originalPaths.join(', ')}`);
    console.log(`  deserialized: ${deserializedPaths.join(', ')}`);
}

console.log(`\n${allMatch ? '✓ all records match' : '✗ mismatch detected'}`);

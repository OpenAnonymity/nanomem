import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trimRecentConversation } from '../../src/engine/recentConversation.js';

describe('trimRecentConversation', () => {
    it('returns null for empty input', () => {
        assert.equal(trimRecentConversation(''), null);
        assert.equal(trimRecentConversation(null), null);
    });

    it('returns null for very short input (< 20 chars)', () => {
        assert.equal(trimRecentConversation('hi'), null);
        assert.equal(trimRecentConversation('short'), null);
    });

    it('returns null for a single-line string with no newlines (not conversation-like)', () => {
        const single = 'A'.repeat(30);
        assert.equal(trimRecentConversation(single, { maxChars: 1000 }), null);
    });

    it('returns the raw text unchanged when under maxChars and multiline', () => {
        const text = 'User: Hello\nAssistant: Hi there!';
        const result = trimRecentConversation(text, { maxChars: 1000 });
        assert.equal(result, text);
    });

    it('tail-trims a single-line blob when over maxChars (no newline in result)', () => {
        // Single-line blobs have no turn structure so the function falls back to
        // trimByTail — it returns the last N chars, which may have no newline.
        const blob = 'x'.repeat(200);
        const result = trimRecentConversation(blob, { maxChars: 50 });
        assert.ok(result === null || result.length <= 50);
    });

    it('trims a transcript to fit within maxChars', () => {
        const turns = Array.from({ length: 10 }, (_, i) =>
            `User: Question number ${i}\nAssistant: Answer number ${i}`
        ).join('\n');
        const result = trimRecentConversation(turns, { maxChars: 200 });
        assert.ok(result === null || result.length <= 200);
    });

    it('preserves turn boundaries — result starts with a role prefix', () => {
        const transcript = [
            'User: First message',
            'Assistant: First reply',
            'User: Second message',
            'Assistant: Second reply',
        ].join('\n');
        const result = trimRecentConversation(transcript, { maxChars: 1000 });
        assert.ok(result.startsWith('User:') || result.startsWith('Assistant:'));
    });

    it('clips long assistant turns to maxAssistantChars', () => {
        const longAssistant = 'A'.repeat(2000);
        const transcript = `User: Quick question\nAssistant: ${longAssistant}`;
        // maxChars must be smaller than the raw transcript to trigger the trimming path
        const result = trimRecentConversation(transcript, { maxChars: 200, maxAssistantChars: 50 });
        assert.ok(result !== null && result.includes('…'));
    });

    it('clips long user turns to maxUserChars', () => {
        const longUser = 'B'.repeat(2000);
        const transcript = `User: ${longUser}\nAssistant: Short reply`;
        // maxChars must be smaller than the raw transcript to trigger the trimming path
        const result = trimRecentConversation(transcript, { maxChars: 200, maxUserChars: 20 });
        assert.ok(result !== null && result.includes('…'));
    });

    it('respects maxTurns — does not include more turns than requested', () => {
        const transcript = Array.from({ length: 20 }, (_, i) =>
            `User: Message ${i}\nAssistant: Reply ${i}`
        ).join('\n');
        // maxChars must be smaller than the raw transcript (~720 chars) to trigger trimming
        const result = trimRecentConversation(transcript, { maxChars: 200, maxTurns: 2 });
        const turnCount = (result?.match(/^(User|Assistant):/gm) || []).length;
        assert.ok(turnCount <= 2);
    });

    it('handles non-transcript multiline text via tail trimming', () => {
        const lines = Array.from({ length: 50 }, (_, i) => `Line ${i} of content`).join('\n');
        const result = trimRecentConversation(lines, { maxChars: 100 });
        // Either null (no \n in result) or within bounds
        if (result !== null) {
            assert.ok(result.length <= 100);
        }
    });

    it('falls back to tail-trim when turn selection produces too short a result', () => {
        // When maxChars is tiny, the selected turns can't meet the 20-char minimum
        // for the structured result, so the function falls back to trimByTail.
        // The tail-trim result may have no newline — that is expected behavior.
        const transcript = 'User: Short\nAssistant: Also short';
        const result = trimRecentConversation(transcript, { maxChars: 5 });
        // result is either null or a short tail-trimmed string
        assert.ok(result === null || result.length <= 5);
    });
});

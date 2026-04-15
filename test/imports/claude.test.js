import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isClaudeExport, parseClaudeExport } from '../../src/internal/imports/claude.js';

let _uuidCounter = 0;

/**
 * Minimal Claude export structure.
 * Real exports are arrays of conversation objects with `uuid`, `name`,
 * `chat_messages` (flat array), and ISO timestamps. Each message has a
 * `sender` ("human" | "assistant") and a `content` array of typed blocks.
 */
function makeClaudeExport(conversations) {
    return conversations.map(({ name, updated_at, messages }) => ({
        uuid: `uuid-${_uuidCounter++}`,
        name: name || '',
        summary: '',
        created_at: updated_at || '2025-06-01T00:00:00Z',
        updated_at: updated_at || '2025-06-01T00:00:00Z',
        account: { uuid: `uuid-${_uuidCounter++}` },
        chat_messages: messages.map((msg) => ({
            uuid: `uuid-${_uuidCounter++}`,
            text: typeof msg.content === 'string' ? msg.content : '',
            content: Array.isArray(msg.content)
                ? msg.content
                : [{ type: 'text', text: msg.content, start_timestamp: updated_at, stop_timestamp: updated_at, flags: null, citations: [] }],
            sender: msg.sender,
            created_at: updated_at || '2025-06-01T00:00:00Z',
            updated_at: updated_at || '2025-06-01T00:00:00Z',
            attachments: [],
            files: [],
            parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        })),
    }));
}

describe('isClaudeExport', () => {
    it('returns true for a valid Claude export', () => {
        const data = makeClaudeExport([{
            name: 'Test',
            updated_at: '2025-06-01T00:00:00Z',
            messages: [{ sender: 'human', content: 'hi' }],
        }]);
        assert.equal(isClaudeExport(data), true);
    });

    it('returns false for an empty array', () => {
        assert.equal(isClaudeExport([]), false);
    });

    it('returns false for non-array input', () => {
        assert.equal(isClaudeExport('string'), false);
        assert.equal(isClaudeExport(null), false);
        assert.equal(isClaudeExport({}), false);
    });

    it('returns false for a ChatGPT export', () => {
        const chatgpt = [{ mapping: {}, current_node: 'node-0', title: 'Test' }];
        assert.equal(isClaudeExport(chatgpt), false);
    });

    it('returns false for an array of plain messages', () => {
        const messages = [{ role: 'user', content: 'hi' }];
        assert.equal(isClaudeExport(messages), false);
    });
});

describe('parseClaudeExport', () => {
    it('parses a single conversation with human and assistant messages', () => {
        const data = makeClaudeExport([{
            name: 'Recipe help',
            updated_at: '2025-06-15T12:00:00Z',
            messages: [
                { sender: 'human', content: 'How do I make ramen?' },
                { sender: 'assistant', content: 'Start with the broth.' },
            ],
        }]);

        const sessions = parseClaudeExport(data);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].title, 'Recipe help');
        assert.equal(sessions[0].messages.length, 2);
        assert.equal(sessions[0].messages[0].role, 'user');
        assert.equal(sessions[0].messages[0].content, 'How do I make ramen?');
        assert.equal(sessions[0].messages[1].role, 'assistant');
        assert.equal(sessions[0].messages[1].content, 'Start with the broth.');
    });

    it('parses multiple conversations', () => {
        const data = makeClaudeExport([
            {
                name: 'First chat',
                updated_at: '2025-06-01T00:00:00Z',
                messages: [{ sender: 'human', content: 'Hello' }],
            },
            {
                name: 'Second chat',
                updated_at: '2025-06-02T00:00:00Z',
                messages: [
                    { sender: 'human', content: 'Question' },
                    { sender: 'assistant', content: 'Answer' },
                ],
            },
        ]);

        const sessions = parseClaudeExport(data);
        assert.equal(sessions.length, 2);
        assert.equal(sessions[0].title, 'First chat');
        assert.equal(sessions[1].title, 'Second chat');
    });

    it('skips conversations with no extractable messages', () => {
        const data = makeClaudeExport([
            { name: 'Empty', updated_at: '2025-06-01T00:00:00Z', messages: [] },
            {
                name: 'Has content',
                updated_at: '2025-06-01T00:00:00Z',
                messages: [{ sender: 'human', content: 'Hi' }],
            },
        ]);

        const sessions = parseClaudeExport(data);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].title, 'Has content');
    });

    it('filters out tool_use, tool_result, and token_budget content blocks', () => {
        const data = makeClaudeExport([{
            name: 'With tools',
            updated_at: '2025-06-01T00:00:00Z',
            messages: [
                { sender: 'human', content: 'Analyze this data' },
                {
                    sender: 'assistant',
                    content: [
                        { type: 'text', text: 'Let me look at that.' },
                        { type: 'tool_use', id: 'tool-1', name: 'python', input: {} },
                        { type: 'tool_result', text: 'result data' },
                        { type: 'token_budget', text: '' },
                        { type: 'text', text: 'Here are the results.' },
                    ],
                },
            ],
        }]);

        const sessions = parseClaudeExport(data);
        assert.equal(sessions[0].messages.length, 2);
        assert.equal(sessions[0].messages[1].content, 'Let me look at that.\nHere are the results.');
    });

    it('skips messages where all content blocks are non-text', () => {
        const data = makeClaudeExport([{
            name: 'Only tools',
            updated_at: '2025-06-01T00:00:00Z',
            messages: [
                { sender: 'human', content: 'Do something' },
                {
                    sender: 'assistant',
                    content: [
                        { type: 'tool_use', id: 'tool-1', name: 'python', input: {} },
                        { type: 'tool_result', text: 'output' },
                    ],
                },
                { sender: 'assistant', content: 'Final answer.' },
            ],
        }]);

        const sessions = parseClaudeExport(data);
        // The middle message has no text blocks so it should be skipped
        assert.equal(sessions[0].messages.length, 2);
        assert.equal(sessions[0].messages[0].role, 'user');
        assert.equal(sessions[0].messages[1].role, 'assistant');
        assert.equal(sessions[0].messages[1].content, 'Final answer.');
    });

    it('extracts updatedAt as ISO date', () => {
        const data = makeClaudeExport([{
            name: 'Dated',
            updated_at: '2025-06-15T14:30:00Z',
            messages: [{ sender: 'human', content: 'test' }],
        }]);

        const sessions = parseClaudeExport(data);
        assert.equal(sessions[0].updatedAt, '2025-06-15');
    });

    it('handles null/empty name gracefully', () => {
        const data = makeClaudeExport([{
            name: '',
            updated_at: '2025-06-01T00:00:00Z',
            messages: [{ sender: 'human', content: 'test' }],
        }]);

        const sessions = parseClaudeExport(data);
        assert.equal(sessions[0].title, null);
    });

    it('ignores messages with unknown sender values', () => {
        const data = makeClaudeExport([{
            name: 'Mixed senders',
            updated_at: '2025-06-01T00:00:00Z',
            messages: [
                { sender: 'human', content: 'Hi' },
                { sender: 'system', content: 'System prompt' },
                { sender: 'assistant', content: 'Hello!' },
            ],
        }]);

        const sessions = parseClaudeExport(data);
        assert.equal(sessions[0].messages.length, 2);
        assert.equal(sessions[0].messages[0].role, 'user');
        assert.equal(sessions[0].messages[1].role, 'assistant');
    });
});

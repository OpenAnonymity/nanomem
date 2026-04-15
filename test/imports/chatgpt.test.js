import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isChatGptExport, parseChatGptExport } from '../../src/internal/imports/chatgpt.js';

/**
 * Minimal ChatGPT export structure.
 * Real exports use a tree-based `mapping` with `current_node` to trace the
 * active conversation path. Each node wraps a `message` object with
 * `author.role`, `content.content_type`, and `content.parts`.
 */
function makeChatGptExport(conversations) {
    return conversations.map(({ title, update_time, messages }) => {
        // Build a linear parent chain from the messages
        const mapping = {};
        let prevId = null;
        let lastId = null;

        for (let i = 0; i < messages.length; i++) {
            const id = `node-${i}`;
            mapping[id] = {
                parent: prevId,
                message: {
                    author: { role: messages[i].role },
                    content: {
                        content_type: 'text',
                        parts: [messages[i].content],
                    },
                    create_time: (update_time || 1700000000) + i,
                },
            };
            prevId = id;
            lastId = id;
        }

        return { title, update_time, mapping, current_node: lastId };
    });
}

describe('isChatGptExport', () => {
    it('returns true for a valid ChatGPT export', () => {
        const data = makeChatGptExport([{
            title: 'Test',
            update_time: 1700000000,
            messages: [{ role: 'user', content: 'hi' }],
        }]);
        assert.equal(isChatGptExport(data), true);
    });

    it('returns false for an empty array', () => {
        assert.equal(isChatGptExport([]), false);
    });

    it('returns false for non-array input', () => {
        assert.equal(isChatGptExport('string'), false);
        assert.equal(isChatGptExport(null), false);
        assert.equal(isChatGptExport({}), false);
    });

    it('returns false for an array without mapping key', () => {
        assert.equal(isChatGptExport([{ chat_messages: [], uuid: 'abc' }]), false);
    });
});

describe('parseChatGptExport', () => {
    it('parses a single conversation with user and assistant messages', () => {
        const data = makeChatGptExport([{
            title: 'Recipe help',
            update_time: 1700000000,
            messages: [
                { role: 'user', content: 'How do I make ramen?' },
                { role: 'assistant', content: 'Start with the broth.' },
            ],
        }]);

        const sessions = parseChatGptExport(data);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].title, 'Recipe help');
        assert.equal(sessions[0].messages.length, 2);
        assert.equal(sessions[0].messages[0].role, 'user');
        assert.equal(sessions[0].messages[0].content, 'How do I make ramen?');
        assert.equal(sessions[0].messages[1].role, 'assistant');
    });

    it('parses multiple conversations', () => {
        const data = makeChatGptExport([
            {
                title: 'First chat',
                update_time: 1700000000,
                messages: [{ role: 'user', content: 'Hello' }],
            },
            {
                title: 'Second chat',
                update_time: 1700100000,
                messages: [
                    { role: 'user', content: 'Question' },
                    { role: 'assistant', content: 'Answer' },
                ],
            },
        ]);

        const sessions = parseChatGptExport(data);
        assert.equal(sessions.length, 2);
        assert.equal(sessions[0].title, 'First chat');
        assert.equal(sessions[1].title, 'Second chat');
    });

    it('skips conversations with no messages', () => {
        const data = makeChatGptExport([
            { title: 'Empty', update_time: 1700000000, messages: [] },
            {
                title: 'Has content',
                update_time: 1700000000,
                messages: [{ role: 'user', content: 'Hi' }],
            },
        ]);

        const sessions = parseChatGptExport(data);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].title, 'Has content');
    });

    it('skips tool and system role messages', () => {
        const data = [{
            title: 'With tool calls',
            update_time: 1700000000,
            current_node: 'node-2',
            mapping: {
                'node-0': {
                    parent: null,
                    message: {
                        author: { role: 'user' },
                        content: { content_type: 'text', parts: ['Search for X'] },
                        create_time: 1700000000,
                    },
                },
                'node-1': {
                    parent: 'node-0',
                    message: {
                        author: { role: 'tool' },
                        content: { content_type: 'text', parts: ['tool result'] },
                        create_time: 1700000001,
                    },
                },
                'node-2': {
                    parent: 'node-1',
                    message: {
                        author: { role: 'assistant' },
                        content: { content_type: 'text', parts: ['Here is what I found'] },
                        create_time: 1700000002,
                    },
                },
            },
        }];

        const sessions = parseChatGptExport(data);
        assert.equal(sessions[0].messages.length, 2);
        assert.equal(sessions[0].messages[0].role, 'user');
        assert.equal(sessions[0].messages[1].role, 'assistant');
    });

    it('extracts updatedAt as ISO date', () => {
        const data = makeChatGptExport([{
            title: 'Dated',
            update_time: 1700000000,
            messages: [{ role: 'user', content: 'test' }],
        }]);

        const sessions = parseChatGptExport(data);
        assert.ok(sessions[0].updatedAt);
        assert.match(sessions[0].updatedAt, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('handles null title gracefully', () => {
        const data = makeChatGptExport([{
            title: null,
            update_time: 1700000000,
            messages: [{ role: 'user', content: 'test' }],
        }]);

        const sessions = parseChatGptExport(data);
        assert.equal(sessions[0].title, null);
    });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryRetriever } from '../../src/tools/retrieval.js';

function createBackend() {
    return {
        init: async () => {},
        getTree: async () => '- personal/about.md',
        exportAll: async () => [{ path: 'personal/about.md', itemCount: 1 }],
        read: async () => '## Long-term memory\n- Prefers concise answers | confidence=1',
        search: async () => [],
        resolvePath: async (path) => path
    };
}

test('augmentQueryForPrompt aborts an in-flight retrieval request', async () => {
    const controller = new AbortController();
    let receivedSignal = null;
    let startStream = null;
    const streamStarted = new Promise((resolve) => {
        startStream = resolve;
    });

    const llmClient = {
        streamChatCompletion: ({ signal }) => {
            receivedSignal = signal;
            startStream();
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        },
        createChatCompletion: async () => {
            throw new Error('createChatCompletion should not be used in this test');
        }
    };

    const retriever = new MemoryRetriever({
        backend: createBackend(),
        bulletIndex: null,
        llmClient,
        model: 'test-model',
        onProgress: () => {},
        onModelText: null
    });

    const pending = retriever.augmentQueryForPrompt('Use my memory.', '', {
        signal: controller.signal
    });
    await streamStarted;
    controller.abort();

    await assert.rejects(pending, (error) => error?.name === 'AbortError');
    assert.equal(receivedSignal, controller.signal);
});

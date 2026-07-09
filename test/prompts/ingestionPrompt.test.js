import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ingestionPrompt as conversationIngestionPrompt } from '../../src/prompts/ingestion/conversation.js';
import { ingestionPrompt as documentIngestionPrompt } from '../../src/prompts/ingestion/document.js';

describe('conversation ingestion prompt', () => {
    it('allows grounded llm_infer facts without permitting hallucinated memories', () => {
        assert.ok(conversationIngestionPrompt.includes('source=llm_infer'));
        assert.ok(conversationIngestionPrompt.includes('follows directly from their explicit statements'));
        assert.ok(conversationIngestionPrompt.includes('must not add new entities, attributes, causes, motives, or sensitive/private details'));
        assert.ok(conversationIngestionPrompt.includes('Do not turn a one-off request, one-off event, or task-specific constraint into a durable preference'));
        assert.ok(conversationIngestionPrompt.includes('When in doubt, do not save'));
    });

    it('does not forbid every inferred fact in the general ingestion prompt', () => {
        assert.equal(
            conversationIngestionPrompt.includes('CRITICAL: Only save facts the user explicitly stated. Do NOT infer'),
            false,
        );
        assert.equal(conversationIngestionPrompt.includes('Only skip facts that are inferred'), false);
    });
});

describe('document ingestion prompt', () => {
    it('uses the same grounded-inference framing with document-specific sources', () => {
        assert.ok(documentIngestionPrompt.includes('source=document'));
        assert.ok(documentIngestionPrompt.includes('source=llm_infer'));
        assert.ok(documentIngestionPrompt.includes('directly stated, clearly shown, or strongly supported by the document'));
        assert.ok(documentIngestionPrompt.includes('must not add new entities, attributes, causes, motives, or sensitive/private details'));
        assert.ok(documentIngestionPrompt.includes('When in doubt, either save the directly supported concrete fact as source=document or skip it'));
    });
});

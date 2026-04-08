/**
 * Shared type definitions for @openanonymity/nanomem.
 *
 * This file contains only JSDoc typedefs. It has no runtime code.
 * Import types with: @import { TypeName } from './types.js'
 */

// ─── Bullet types ────────────────────────────────────────────────────────────

/**
 * @typedef {'working' | 'long_term' | 'history'} Tier
 */

/**
 * @typedef {'active' | 'superseded' | 'expired' | 'uncertain'} Status
 */

/**
 * @typedef {'user_statement' | 'llm_infer' | 'document' | 'document_infer' | 'assistant_summary' | 'inference' | 'system'} Source
 */

/**
 * @typedef {'high' | 'medium' | 'low'} Confidence
 */

/**
 * @typedef {object} Bullet
 * @property {string} text
 * @property {string | null} topic
 * @property {string | null} updatedAt
 * @property {string | null} expiresAt
 * @property {string | null} reviewAt
 * @property {Tier} tier
 * @property {Status} status
 * @property {Source | null} source
 * @property {Confidence | null} confidence
 * @property {boolean} explicitTier
 * @property {boolean} explicitStatus
 * @property {boolean} explicitSource
 * @property {boolean} explicitConfidence
 * @property {string} heading
 * @property {string} section
 * @property {number} lineIndex
 */

/**
 * @typedef {object} EnsureBulletMetadataOptions
 * @property {string} [defaultTopic]
 * @property {Tier} [defaultTier]
 * @property {Status} [defaultStatus]
 * @property {Source} [defaultSource]
 * @property {Confidence} [defaultConfidence]
 * @property {string} [updatedAt]
 */

/**
 * @typedef {object} CompactionResult
 * @property {Bullet[]} working
 * @property {Bullet[]} longTerm
 * @property {Bullet[]} history
 * @property {Bullet[]} active
 * @property {Bullet[]} archive
 */

/**
 * @typedef {object} CompactBulletsOptions
 * @property {string} [today]
 * @property {number} [maxActivePerTopic]
 * @property {string} [defaultTopic]
 */

// ─── Storage types ───────────────────────────────────────────────────────────

/**
 * @typedef {object} StorageMetadata
 * @property {string} [oneLiner]
 * @property {number} [itemCount]
 * @property {string[]} [titles]
 */

/**
 * @typedef {object} ExportRecord
 * @property {string} path
 * @property {string} [content]
 * @property {string} [oneLiner]
 * @property {number} [itemCount]
 * @property {string[]} [titles]
 * @property {string} [parentPath]
 * @property {number} [createdAt]
 * @property {number} [updatedAt]
 */

/**
 * @typedef {object} SearchResult
 * @property {string} path
 * @property {string[]} lines
 */

/**
 * @typedef {object} ListResult
 * @property {string[]} files
 * @property {string[]} dirs
 */

// ─── LLM types ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} ToolCallFunction
 * @property {string} name
 * @property {string} arguments
 */

/**
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {'function'} type
 * @property {ToolCallFunction} function
 */

/**
 * @typedef {object} ToolFunctionParameters
 * @property {'object'} type
 * @property {Record<string, { type: string; description?: string }>} properties
 * @property {string[]} required
 */

/**
 * @typedef {object} ToolFunctionDef
 * @property {string} name
 * @property {string} description
 * @property {ToolFunctionParameters} parameters
 */

/**
 * @typedef {object} ToolDefinition
 * @property {'function'} type
 * @property {ToolFunctionDef} function
 */

/**
 * @typedef {object} LLMMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string | null} [content]
 * @property {ToolCall[]} [tool_calls]
 * @property {string} [tool_call_id]
 */

/**
 * @typedef {object} ChatCompletionParams
 * @property {string} model
 * @property {LLMMessage[]} messages
 * @property {ToolDefinition[]} [tools]
 * @property {number} [max_tokens]
 * @property {number} [temperature]
 */

/**
 * @typedef {object} StreamChatCompletionParams
 * @property {string} model
 * @property {LLMMessage[]} messages
 * @property {ToolDefinition[]} [tools]
 * @property {number} [max_tokens]
 * @property {number} [temperature]
 * @property {(text: string) => void} [onDelta]
 * @property {(text: string) => void} [onReasoning]
 */

/**
 * @typedef {object} ChatCompletionResponse
 * @property {string} content
 * @property {ToolCall[]} tool_calls
 * @property {{ prompt_tokens: number; completion_tokens: number } | null} usage
 */

/**
 * @typedef {object} LLMClient
 * @property {(params: ChatCompletionParams) => Promise<ChatCompletionResponse>} createChatCompletion
 * @property {(params: StreamChatCompletionParams) => Promise<ChatCompletionResponse>} streamChatCompletion
 */

/**
 * @typedef {object} LLMClientOptions
 * @property {string} apiKey
 * @property {string} [baseUrl]
 * @property {Record<string, string>} [headers]
 */

// ─── Engine types ────────────────────────────────────────────────────────────

/**
 * @typedef {'init' | 'retrieval' | 'fallback' | 'tool_call' | 'reasoning' | 'loading' | 'complete'} ProgressStage
 */

/**
 * @typedef {object} ProgressEvent
 * @property {ProgressStage} stage
 * @property {string} message
 * @property {string} [tool]
 * @property {Record<string, any>} [args]
 * @property {string | Record<string, any>} [result]
 * @property {string[]} [paths]
 * @property {number} [iteration]
 * @property {string} [path]
 */

/**
 * @typedef {object} RetrievalResult
 * @property {{ path: string; content: string }[]} files
 * @property {string[]} paths
 * @property {string | null} assembledContext
 */

/**
 * @typedef {object} IngestOptions
 * @property {string} [updatedAt]
 * @property {'conversation' | 'document' | string} [mode] - Prompt set to use for extraction
 * @property {'conversation' | 'document' | string} [extractionMode] - Alias for mode (deprecated, use mode)
 * @property {string} [sessionTitle]
 */

/**
 * @typedef {object} IngestResult
 * @property {'processed' | 'skipped' | 'error'} status
 * @property {number} writeCalls
 * @property {string} [error]
 */

/**
 * @typedef {object} ToolCallLogEntry
 * @property {string} name
 * @property {Record<string, any>} args
 * @property {string} result
 * @property {string} toolCallId
 */

/**
 * @typedef {object} ToolLoopResult
 * @property {string} textResponse
 * @property {{ name: string; arguments: Record<string, any> } | null} terminalToolResult
 * @property {LLMMessage[]} messages
 * @property {number} iterations
 * @property {ToolCallLogEntry[]} toolCallLog
 */

/**
 * @typedef {object} ToolLoopOptions
 * @property {LLMClient} llmClient
 * @property {string} model
 * @property {ToolDefinition[]} tools
 * @property {Record<string, ToolExecutor>} toolExecutors
 * @property {LLMMessage[]} messages
 * @property {string | null} [terminalTool]
 * @property {number} [maxIterations]
 * @property {number} [maxOutputTokens]
 * @property {number} [temperature]
 * @property {((name: string, args: Record<string, any>, result: string) => void) | null} [onToolCall]
 * @property {((text: string, iteration: number) => void) | null} [onModelText]
 * @property {((chunk: string, iteration: number) => void) | null} [onReasoning]
 * @property {AbortSignal | null} [signal]
 */

/**
 * @typedef {object} ExtractionExecutorHooks
 * @property {(content: string, path: string) => string} [normalizeContent]
 * @property {(existing: string | null, incoming: string, path: string) => string} [mergeWithExisting]
 * @property {(path: string) => Promise<void>} [refreshIndex]
 */

/**
 * @typedef {(args: any) => Promise<string>} ToolExecutor
 */

/**
 * @typedef {object} StorageBackend
 * @property {() => Promise<void>} init
 * @property {(path: string) => Promise<string | null>} read
 * @property {(path: string, content: string) => Promise<void>} write
 * @property {(path: string) => Promise<void>} delete
 * @property {(path: string) => Promise<boolean>} exists
 * @property {(query: string) => Promise<SearchResult[]>} search
 * @property {(dirPath?: string) => Promise<ListResult>} ls
 * @property {() => Promise<string | null>} getTree
 * @property {() => Promise<void>} rebuildTree
 * @property {() => Promise<ExportRecord[]>} exportAll
 * @property {() => Promise<void>} clear
 */

/**
 * @typedef {object} StorageFacade
 * @property {(path: string) => Promise<string | null>} read
 * @property {(path: string, content: string) => Promise<void>} write
 * @property {(path: string) => Promise<void>} delete
 * @property {(path: string) => Promise<boolean>} exists
 * @property {(query: string) => Promise<SearchResult[]>} search
 * @property {(dirPath?: string) => Promise<ListResult>} ls
 * @property {() => Promise<string | null>} getTree
 * @property {() => Promise<void>} rebuildTree
 * @property {() => Promise<ExportRecord[]>} exportAll
 * @property {() => Promise<void>} clear
 */

// ─── Memory bank config ─────────────────────────────────────────────────────

/**
 * @typedef {object} MemoryBankLLMConfig
 * @property {string} apiKey
 * @property {string} [baseUrl]
 * @property {string} [model]
 * @property {'openai' | 'anthropic' | 'tinfoil' | 'custom' | string} [provider]
 * @property {Record<string, string>} [headers]
 */

/**
 * @typedef {object} MemoryBankConfig
 * @property {MemoryBankLLMConfig} [llm]
 * @property {LLMClient} [llmClient]
 * @property {string} [model]
 * @property {'ram' | 'filesystem' | 'indexeddb' | StorageBackend} [storage]
 * @property {string} [storagePath]
 * @property {(event: ProgressEvent) => void} [onProgress]
 * @property {(name: string, args: Record<string, any>, result: string) => void} [onToolCall]
 * @property {(text: string) => void} [onModelText]
 */

// ─── Import types ────────────────────────────────────────────────────────────

/**
 * @typedef {object} Message
 * @property {'user' | 'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {object} ChatGptSession
 * @property {string | null} title
 * @property {Message[]} messages
 * @property {string | null} updatedAt
 */

/**
 * @typedef {object} SessionSummary
 * @property {string} id
 * @property {string} title
 * @property {number | null} createdAt
 * @property {number | null} updatedAt
 * @property {number | null} messageCount
 * @property {string | null} model
 */

/**
 * @typedef {object} SessionWithConversation
 * @property {SessionSummary} session
 * @property {Message[]} conversation
 */

// ─── Bullet index types ──────────────────────────────────────────────────────

/**
 * @typedef {object} BulletItem
 * @property {string} path
 * @property {Bullet} bullet
 * @property {number} fileUpdatedAt
 */

/**
 * @typedef {object} MemoryBank
 * @property {() => Promise<void>} init
 * @property {(query: string, conversationText?: string) => Promise<RetrievalResult | null>} retrieve
 * @property {(messages: Message[], options?: IngestOptions) => Promise<IngestResult>} ingest
 * @property {() => Promise<void>} compact
 * @property {StorageFacade} storage
 * @property {() => Promise<string>} serialize
 * @property {() => Promise<Uint8Array>} toZip
 * @property {StorageBackend} _backend
 * @property {import('./bullets/bulletIndex.js').MemoryBulletIndex} _bulletIndex
 */

export {};

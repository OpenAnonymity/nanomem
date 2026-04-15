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
 * @property {Record<string, { type: string; description?: string; items?: object }>} properties
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
 * @property {string} [finish_reason]
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
 * @property {'started' | 'finished'} [toolState]
 * @property {string} [toolCallId]
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
 * @typedef {object} AugmentQueryResult
 * @property {{ path: string; content: string }[]} files
 * @property {string[]} paths
 * @property {string} reviewPrompt
 * @property {string} apiPrompt
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
 * @property {Array<{path: string, before: string | null, after: string | null}>} [writes]
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
 * @typedef {object} ToolCallEventMeta
 * @property {'started' | 'finished'} status
 * @property {string} toolCallId
 * @property {number} iteration
 * @property {boolean} [terminal]
 */

/**
 * @typedef {object} ToolLoopResult
 * @property {string} textResponse
 * @property {{ name: string; arguments: Record<string, any>; result?: string } | null} terminalToolResult
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
 * @property {((name: string, args: Record<string, any>, result: string | null, meta: ToolCallEventMeta) => void) | null} [onToolCall]
 * @property {((text: string, iteration: number) => void) | null} [onModelText]
 * @property {((chunk: string, iteration: number) => void) | null} [onReasoning]
 * @property {AbortSignal | null} [signal]
 * @property {boolean} [executeTerminalTool]
 */

/**
 * @typedef {object} ExtractionExecutorHooks
 * @property {(content: string, path: string) => string} [normalizeContent]
 * @property {(existing: string | null, incoming: string, path: string) => string} [mergeWithExisting]
 * @property {(path: string) => Promise<void>} [refreshIndex]
 * @property {(path: string, before: string, after: string) => void} [onWrite]
 * @property {string} [updatedAt]
 */

/**
 * @typedef {(args: any) => Promise<string>} ToolExecutor
 */

/**
 * @typedef {object} StorageBackend
 * @property {() => Promise<void>} init
 * @property {(path: string) => Promise<string | null>} read
 * @property {(path: string) => Promise<string | null>} [resolvePath]
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
 * @property {(path: string) => Promise<string | null>} [resolvePath]
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
 * @property {string} [enclaveURL]
 * @property {string} [configRepo]
 * @property {string} [attestationBundleURL]
 * @property {'ehbp' | 'tls'} [transport]
 */

/**
 * @typedef {object} MemoryBankConfig
 * @property {MemoryBankLLMConfig} [llm]
 * @property {LLMClient} [llmClient]
 * @property {string} [model]
 * @property {'ram' | 'filesystem' | 'indexeddb' | StorageBackend} [storage]
 * @property {string} [storagePath]
 * @property {(event: ProgressEvent) => void} [onProgress]
 * @property {(event: ProgressEvent) => void} [onCompactProgress]
 * @property {(name: string, args: Record<string, any>, result: string | null, meta: ToolCallEventMeta) => void} [onToolCall]
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
 * @typedef {object} MemoryImportConversation
 * @property {string | null} [title]
 * @property {Message[]} messages
 * @property {string | number | null} [updatedAt]
 * @property {'conversation' | 'document'} [mode]
 */

/**
 * @typedef {'auto' | 'normalized' | 'oa-fastchat' | 'chatgpt' | 'messages' | 'transcript' | 'markdown'} ImportFormat
 */

/**
 * @typedef {object} ImportProgressEvent
 * @property {'start' | 'item_start' | 'item_complete' | 'complete'} stage
 * @property {number} totalItems
 * @property {number} [itemIndex]
 * @property {string | null} [itemTitle]
 * @property {'processed' | 'skipped' | 'error'} [itemStatus]
 * @property {string | null} [itemError]
 */

/**
 * @typedef {object} ImportDataOptions
 * @property {ImportFormat} [format]
 * @property {string} [sourceName]
 * @property {string} [sessionId]
 * @property {string} [sessionTitle]
 * @property {'conversation' | 'document'} [mode]
 * @property {(event: ImportProgressEvent) => void} [onProgress]
 */

/**
 * @typedef {object} ImportDataItemResult
 * @property {string | null} title
 * @property {string | null} updatedAt
 * @property {'processed' | 'skipped' | 'error'} status
 * @property {number} writeCalls
 * @property {string} [error]
 */

/**
 * @typedef {object} ImportDataResult
 * @property {number} totalItems
 * @property {number} imported
 * @property {number} skipped
 * @property {number} errors
 * @property {number} totalWriteCalls
 * @property {string | null} authError
 * @property {ImportDataItemResult[]} results
 */

/**
 * @typedef {object} OmfMemoryItem
 * @property {string} content
 * @property {string} [category]
 * @property {string[]} [tags]
 * @property {'active' | 'archived' | 'expired'} [status]
 * @property {string} [created_at]
 * @property {string} [updated_at]
 * @property {string} [expires_at]
 * @property {Record<string, any>} [extensions]
 */

/**
 * @typedef {object} OmfDocument
 * @property {string} omf
 * @property {string} exported_at
 * @property {{ app?: string }} [source]
 * @property {OmfMemoryItem[]} memories
 */

/**
 * @typedef {object} OmfImportOptions
 * @property {boolean} [includeArchived]
 */

/**
 * @typedef {object} OmfImportPreview
 * @property {number} total
 * @property {number} filtered
 * @property {number} toImport
 * @property {number} duplicates
 * @property {number} newFiles
 * @property {number} existingFiles
 * @property {Record<string, { new: number, duplicate: number, document?: boolean }>} byFile
 */

/**
 * @typedef {object} OmfImportResult
 * @property {number} total
 * @property {number} imported
 * @property {number} duplicates
 * @property {number} skipped
 * @property {number} filesWritten
 * @property {string[]} errors
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
 * @property {(query: string, conversationText?: string) => Promise<AugmentQueryResult | null>} augmentQuery
 * @property {(messages: Message[], options?: IngestOptions) => Promise<IngestResult>} ingest
 * @property {(input: string | unknown | MemoryImportConversation | MemoryImportConversation[] | Array<{ path: string, content: string }>, options?: ImportDataOptions) => Promise<ImportDataResult>} importData
 * @property {() => Promise<OmfDocument>} exportOmf
 * @property {(doc: OmfDocument, options?: OmfImportOptions) => Promise<OmfImportPreview>} previewOmfImport
 * @property {(doc: OmfDocument, options?: OmfImportOptions) => Promise<OmfImportResult>} importOmf
 * @property {() => Promise<{filesChanged: number, filesTotal: number} | undefined>} compact
 * @property {(query: string, options?: {deep?: boolean, mode?: string}) => Promise<{status: string, deleteCalls: number, writes: Array<any>}>} [deleteContent]
 * @property {StorageFacade} storage
 * @property {() => Promise<string>} serialize
 * @property {() => Promise<Uint8Array>} toZip
 * @property {StorageBackend} _backend
 * @property {import('./internal/format/bulletIndex.js').MemoryBulletIndex} _bulletIndex
 */

export {};

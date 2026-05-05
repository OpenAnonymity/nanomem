/**
 * AgenticToolLoop — Backend-agnostic agentic tool-calling loop.
 *
 * Sends messages to an LLM with OpenAI-format tool definitions, executes
 * tool calls locally, and loops until the LLM stops calling tools or a
 * terminal tool is invoked.  When an onReasoning callback is provided,
 * uses streaming to surface reasoning tokens in real time; otherwise
 * uses non-streaming requests for reliable tool call parsing.
 */
/** @import { ToolLoopOptions, ToolLoopResult, ChatCompletionResponse, ToolCall, LLMMessage } from '../types.js' */

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_OUTPUT_TOKENS = 500;
const DEFAULT_TEMPERATURE = 0;

/**
 * Run an agentic tool-calling loop.
 *
 * @param {ToolLoopOptions} options
 * @returns {Promise<ToolLoopResult>}
 */
export async function runAgenticToolLoop(options) {
    const {
        llmClient,
        model,
        tools,
        toolExecutors,
        messages: initialMessages,
        terminalTool = null,
        maxIterations = DEFAULT_MAX_ITERATIONS,
        maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
        temperature = DEFAULT_TEMPERATURE,
        onToolCall = null,
        onModelText = null,
        onReasoning = null,
        signal = null,
        executeTerminalTool = false
    } = options;

    const messages = [...initialMessages];
    const toolCallLog = [];
    let textResponse = '';
    let terminalToolResult = null;
    let iterations = 0;
    const throwIfAborted = () => {
        if (signal?.aborted) {
            throw createAbortError();
        }
    };
    const emitToolCall = (name, args, result, meta) => {
        onToolCall?.(name, args, result, meta);
    };

    // Stream when onReasoning is provided (surfaces reasoning tokens in real time).
    // Otherwise use non-streaming createChatCompletion for reliable tool call parsing.
    const useStreaming = !!onReasoning && !!llmClient.streamChatCompletion;

    for (let i = 0; i < maxIterations; i++) {
        throwIfAborted();
        iterations++;

        const requestPayload = {
            model,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
                ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
            })),
            tools,
            max_tokens: maxOutputTokens,
            temperature
        };

        let response;
        let iterationText = '';

        if (useStreaming) {
            response = await llmClient.streamChatCompletion({
                ...requestPayload,
                signal,
                onDelta: (d) => { iterationText += d; },
                onReasoning: (d) => { onReasoning(d, iterations); }
            });
        } else {
            response = await llmClient.createChatCompletion({
                ...requestPayload,
                signal
            });
        }
        throwIfAborted();

        // If output was truncated and no tool calls came through, retry once with 2× tokens.
        if (response.finish_reason === 'length' && (response.tool_calls || []).length === 0) {
            const retryTokens = requestPayload.max_tokens * 2;
            const retryPayload = { ...requestPayload, max_tokens: retryTokens };
            iterationText = '';
            response = useStreaming
                ? await llmClient.streamChatCompletion({ ...retryPayload, signal, onDelta: (d) => { iterationText += d; }, onReasoning: (d) => { onReasoning(d, iterations); } })
                : await llmClient.createChatCompletion({ ...retryPayload, signal });
            throwIfAborted();
        }

        const responseToolCalls = response.tool_calls || [];
        const responseText = iterationText || response.content || '';

        // Forward model text to caller (even alongside tool calls)
        if (responseText && onModelText) {
            onModelText(responseText, iterations);
        }

        // No tool calls → LLM is done, return text response
        if (responseToolCalls.length === 0) {
            textResponse = responseText;
            break;
        }

        // Append assistant message with tool_calls to conversation
        messages.push({
            role: 'assistant',
            content: responseText || null,
            tool_calls: responseToolCalls
        });

        // Execute each tool call
        let hitTerminal = false;
        for (const [toolIndex, tc] of responseToolCalls.entries()) {
            throwIfAborted();
            const toolName = tc.function?.name || '';
            let args;
            try {
                args = typeof tc.function?.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : (tc.function?.arguments || {});
            } catch (err) {
                console.warn(`[tool-loop] failed to parse args for ${toolName}: ${err.message}. Raw: ${String(tc.function?.arguments).slice(0, 200)}`);
                args = {};
            }

            const toolCallId = tc.id || `iter-${iterations}-tool-${toolIndex + 1}-${toolName || 'tool'}`;

            // Check for terminal tool
            if (terminalTool && toolName === terminalTool) {
                emitToolCall(toolName, args, null, {
                    status: 'started',
                    toolCallId,
                    iteration: iterations,
                    terminal: true
                });
                let result = '[terminal]';
                if (executeTerminalTool) {
                    const executor = toolExecutors[toolName];
                    if (!executor) {
                        result = JSON.stringify({ error: `Unknown tool: ${toolName}` });
                    } else {
                        try {
                            result = await executor(args);
                        } catch (err) {
                            const message = err instanceof Error ? err.message : String(err);
                            result = JSON.stringify({ error: `Tool error: ${message}` });
                        }
                    }
                }
                throwIfAborted();

                terminalToolResult = { name: toolName, arguments: args, result };
                toolCallLog.push({ name: toolName, args, result, toolCallId });
                emitToolCall(toolName, args, result, {
                    status: 'finished',
                    toolCallId,
                    iteration: iterations,
                    terminal: true
                });

                messages.push({
                    role: 'tool',
                    content: typeof result === 'string'
                        ? result
                        : JSON.stringify(result),
                    tool_call_id: toolCallId
                });
                hitTerminal = true;
                break;
            }

            // Execute the tool
            emitToolCall(toolName, args, null, {
                status: 'started',
                toolCallId,
                iteration: iterations,
                terminal: false
            });
            let result;
            const executor = toolExecutors[toolName];
            if (!executor) {
                result = JSON.stringify({ error: `Unknown tool: ${toolName}` });
            } else {
                try {
                    result = await executor(args);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    result = JSON.stringify({ error: `Tool error: ${message}` });
                }
            }
            throwIfAborted();

            toolCallLog.push({ name: toolName, args, result, toolCallId });
            emitToolCall(toolName, args, result, {
                status: 'finished',
                toolCallId,
                iteration: iterations,
                terminal: false
            });

            // Append tool result
            messages.push({
                role: 'tool',
                content: typeof result === 'string' ? result : JSON.stringify(result),
                tool_call_id: toolCallId
            });
        }

        if (hitTerminal) break;
    }

    return {
        textResponse,
        terminalToolResult,
        messages,
        iterations,
        toolCallLog
    };
}

function createAbortError() {
    const error = new Error('Tool loop aborted.');
    error.name = 'AbortError';
    error.isUserAbort = true;
    return error;
}

/** @import { Message, SessionSummary, SessionWithConversation } from '../../types.js' */

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function normalizeContent(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    return String(content);
}

function matchesSession(session, { sessionId, sessionTitle } = /** @type {{ sessionId?: string, sessionTitle?: string }} */ ({})) {
    if (sessionId) return session?.id === sessionId;
    if (sessionTitle) return session?.title === sessionTitle;
    return true;
}

function toSessionSummary(session) {
    return {
        id: session.id,
        title: session.title || '',
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        messageCount: session.messageCountAtGeneration || null,
        model: session.model || null
    };
}

function toConversationMessages(messages, sessionOrder) {
    return messages
        .sort((a, b) => {
            const sessionDiff = (sessionOrder.get(a?.sessionId) || 0) - (sessionOrder.get(b?.sessionId) || 0);
            if (sessionDiff !== 0) return sessionDiff;
            const timeDiff = (a?.timestamp || 0) - (b?.timestamp || 0);
            if (timeDiff !== 0) return timeDiff;
            return String(a?.id || '').localeCompare(String(b?.id || ''));
        })
        .map((message) => /** @type {Message} */ ({
            role: message?.role === 'assistant' ? 'assistant' : 'user',
            content: normalizeContent(message?.content)
        }))
        .filter((message) => message.content.trim());
}

/**
 * @param {any} exportJson
 * @returns {SessionSummary[]}
 */
export function listOAFastchatSessions(exportJson) {
    const sessions = toArray(exportJson?.data?.chats?.sessions);
    return sessions.map((session) => toSessionSummary(session));
}

/**
 * @param {any} exportJson
 * @param {{ sessionId?: string, sessionTitle?: string }} [options]
 * @returns {SessionWithConversation[]}
 */
export function extractSessionsFromOAFastchatExport(exportJson, options = {}) {
    const sessions = toArray(exportJson?.data?.chats?.sessions);
    const messages = toArray(exportJson?.data?.chats?.messages);

    if (sessions.length === 0) {
        throw new Error('OAFastChat export does not contain any chat sessions.');
    }

    const selectedSessions = sessions.filter((session) => matchesSession(session, options));
    if (selectedSessions.length === 0) {
        const hint = options.sessionId
            ? `sessionId=${options.sessionId}`
            : `sessionTitle=${options.sessionTitle}`;
        throw new Error(`Could not find a chat session matching ${hint}.`);
    }

    const sortedSessions = [...selectedSessions].sort((a, b) => {
        const createdDiff = (a?.createdAt || 0) - (b?.createdAt || 0);
        if (createdDiff !== 0) return createdDiff;
        return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
    const sessionOrder = new Map(sortedSessions.map((session, index) => [session.id, index]));
    const sessionsWithConversation = sortedSessions.map((session) => {
        const sessionMessages = messages.filter((message) => message?.sessionId === session.id);
        const conversation = toConversationMessages(sessionMessages, sessionOrder);
        return {
            session: toSessionSummary(session),
            conversation
        };
    }).filter((entry) => entry.conversation.length > 0);

    if (sessionsWithConversation.length === 0) {
        throw new Error('The selected chat session set does not contain any messages.');
    }

    return sessionsWithConversation;
}

/**
 * @param {any} exportJson
 * @param {{ sessionId?: string, sessionTitle?: string }} [options]
 * @returns {{ session: SessionSummary | null, sessions: SessionSummary[], conversation: Message[] }}
 */
export function extractConversationFromOAFastchatExport(exportJson, options = {}) {
    const sessionsWithConversation = extractSessionsFromOAFastchatExport(exportJson, options);
    const sessionOrder = new Map(sessionsWithConversation.map((entry, index) => [entry.session.id, index]));
    const conversation = toConversationMessages(
        sessionsWithConversation.flatMap((entry) =>
            entry.conversation.map((message, index) => ({
                id: `${entry.session.id}:${index}`,
                sessionId: entry.session.id,
                timestamp: index,
                role: message.role,
                content: message.content
            }))
        ),
        sessionOrder
    );

    return {
        session: sessionsWithConversation.length === 1 ? sessionsWithConversation[0].session : null,
        sessions: sessionsWithConversation.map((entry) => entry.session),
        conversation
    };
}

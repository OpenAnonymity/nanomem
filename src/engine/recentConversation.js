const TURN_PREFIX_RE = /^(User|Assistant):\s*(.*)$/;

function clipTurnText(text, maxChars) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (!maxChars || raw.length <= maxChars) return raw;
    if (maxChars <= 1) return raw.slice(0, maxChars);
    return `${raw.slice(0, maxChars - 1).trimEnd()}…`;
}

function parseTranscript(conversationText) {
    const lines = String(conversationText || '').split('\n');
    const turns = [];
    let current = null;

    for (const line of lines) {
        const match = line.match(TURN_PREFIX_RE);
        if (match) {
            if (current?.text?.trim()) {
                turns.push({ ...current, text: current.text.trim() });
            }
            current = {
                role: match[1],
                text: match[2] || ''
            };
            continue;
        }

        if (!current) continue;
        current.text += `${current.text ? '\n' : ''}${line}`;
    }

    if (current?.text?.trim()) {
        turns.push({ ...current, text: current.text.trim() });
    }

    return turns;
}

function trimByTail(raw, maxChars) {
    let tail = raw.slice(-maxChars);
    const firstNewline = tail.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 200) {
        tail = tail.slice(firstNewline + 1);
    }
    return tail.trim() || null;
}

/**
 * Trim a conversation transcript while preserving turn boundaries and preferring
 * to keep user turns visible even when assistant replies are long.
 *
 * @param {string} conversationText
 * @param {object} options
 * @param {number} options.maxChars
 * @param {number} [options.maxTurns]
 * @param {number} [options.maxUserChars]
 * @param {number} [options.maxAssistantChars]
 * @returns {string | null}
 */
export function trimRecentConversation(conversationText, {
    maxChars,
    maxTurns = 6,
    maxUserChars = 500,
    maxAssistantChars = 900
} = {}) {
    const raw = String(conversationText || '').trim();
    if (!raw || raw.length < 20) return null;
    if (!maxChars || raw.length <= maxChars) {
        return /\n/.test(raw) ? raw : null;
    }

    const turns = parseTranscript(raw);
    if (turns.length === 0) {
        return trimByTail(raw, maxChars);
    }

    const clippedTurns = turns
        .slice(-Math.max(2, maxTurns))
        .map((turn) => {
            const maxTurnChars = turn.role === 'Assistant'
                ? maxAssistantChars
                : maxUserChars;
            return `${turn.role}: ${clipTurnText(turn.text, maxTurnChars)}`;
        });

    const selected = [];
    let totalChars = 0;
    for (let i = clippedTurns.length - 1; i >= 0; i -= 1) {
        const entry = clippedTurns[i];
        const separatorChars = selected.length > 0 ? 2 : 0;
        if (selected.length > 0 && totalChars + separatorChars + entry.length > maxChars) {
            continue;
        }
        if (selected.length === 0 && entry.length > maxChars) {
            selected.unshift(clipTurnText(entry, maxChars));
            totalChars = selected[0].length;
            break;
        }
        selected.unshift(entry);
        totalChars += separatorChars + entry.length;
    }

    const result = selected.join('\n\n').trim();
    if (result.length >= 20 && /\n/.test(result)) {
        return result;
    }

    return trimByTail(raw, maxChars);
}

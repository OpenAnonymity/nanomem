/**
 * CLI output formatting — JSON for pipes, human-readable for terminals.
 */

export function formatOutput(result, flags) {
    if (flags.json || !process.stdout.isTTY) {
        return JSON.stringify(result, null, 2);
    }
    return formatHuman(result);
}

function formatHuman(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result;

    // retrieve → print assembled context directly
    if (result.assembledContext != null) {
        return result.assembledContext || 'No relevant context found.';
    }

    // read → print content directly
    if ('content' in result && 'path' in result) {
        return result.content ?? '';
    }

    // ls → list files and dirs
    if (result.files && result.dirs) {
        const lines = [];
        for (const d of result.dirs) lines.push(d + '/');
        for (const f of result.files) lines.push(f);
        return lines.join('\n') || '(empty)';
    }

    // status → grouped display
    if ('provider' in result && 'storagePath' in result) {
        const dirs = result.directories?.length ? result.directories.join(', ') : '(none)';
        return [
            '  LLM',
            `    Provider      ${result.provider}`,
            `    Model         ${result.model}`,
            `    Base URL      ${result.baseUrl}`,
            '',
            '  Storage',
            `    Backend       ${result.storage}`,
            `    Path          ${result.storagePath}`,
            `    Config        ${result.configFile}`,
            `    Files         ${result.files}`,
            `    Directories   ${dirs}`,
        ].join('\n');
    }

    // search results
    if (Array.isArray(result)) {
        if (result.length === 0) return 'No results.';
        const query = result._query || '';
        return result.map(r => {
            if (!r.path) return JSON.stringify(r);
            const matchLines = (r.lines || [])
                .map(line => '  ' + highlightQuery(line, query))
                .join('\n');
            return `\x1b[1m${r.path}\x1b[0m\n${matchLines}`;
        }).join('\n\n');
    }

    // Status actions
    if (result.status) return formatAction(result);


    // Generic object → key: value
    const pad = Math.max(...Object.keys(result).map(k => k.length));
    const lines = [];
    for (const [k, v] of Object.entries(result)) {
        lines.push(`  ${k.padEnd(pad)}   ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    return lines.join('\n');
}

function formatAction(result) {
    switch (result.status) {
        case 'initialized':
            return lines('\u2713 Memory initialized', [
                ['Backend', result.storage],
                ['Path', result.path],
            ]);
        case 'written':
            return `\u2713 Written to ${result.path}`;
        case 'deleted':
            return `\u2713 Deleted ${result.path}`;
        case 'compacted':
            return '\u2713 Memory compacted';
        case 'processed':
            return lines('\u2713 Facts extracted', [
                ['Files updated', result.writeCalls],
            ]);
        case 'skipped':
            return '\u2013 Nothing to extract (conversation too short)';
        case 'imported':
            return lines('\u2713 Chat history imported', [
                ['Sessions', result.sessions],
                ['Files updated', result.totalWriteCalls],
            ]);
        case 'exported':
            return lines('\u2713 Memory exported', [
                ['Files', result.files],
                ['Format', result.format],
                ['Path', result.path],
            ]);
        case 'cleared':
            return lines('\u2713 Memory cleared', [
                ['Files deleted', result.filesDeleted],
                ['Path', result.path],
            ]);
        case 'logged_in':
            return lines('\u2713 Logged in', [
                ['Provider', result.provider],
                ['Config',   result.configFile],
            ]);
        case 'logged_in_interactive':
            return null; // already printed by the interactive prompt
        case 'error':
            return `\u2717 Extraction failed: ${result.error || 'unknown error'}`;
        default:
            return `\u2713 ${result.status}`;
    }
}

function highlightQuery(text, query) {
    if (!query) return text;
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(re, '\x1b[33;1m$1\x1b[0m');
}

function lines(heading, rows) {
    if (!rows || rows.length === 0) return heading;
    const pad = Math.max(...rows.map(([k]) => k.length));
    const detail = rows
        .map(([k, v]) => `    ${k.padEnd(pad)}   ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n');
    return `${heading}\n\n${detail}`;
}

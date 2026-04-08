/**
 * CLI output formatting — JSON for pipes, human-readable for terminals.
 */

// ─── ANSI helpers ─────────────────────────────────────────────────

const c = {
    reset:  '\x1b[0m',
    bold:   '\x1b[1m',
    dim:    '\x1b[2m',
    cyan:   '\x1b[36m',
    green:  '\x1b[32m',
    red:    '\x1b[31m',
    yellow: '\x1b[33m',
    white:  '\x1b[37m',
    gray:   '\x1b[90m',
};

function col(code, text) {
    if (!process.stdout.isTTY) return text;
    return `${code}${text}${c.reset}`;
}

const dim    = t => col(c.dim, t);
const bold   = t => col(c.bold, t);
const cyan   = t => col(c.cyan, t);
const green  = t => col(c.green, t);
const red    = t => col(c.red, t);
const gray   = t => col(c.gray, t);

// ─── Public ───────────────────────────────────────────────────────

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
        return result.assembledContext || dim('No relevant context found.');
    }

    // read → print content directly
    if ('content' in result && 'path' in result) {
        return result.content ?? '';
    }

    // ls → list files and dirs
    if (result.files && result.dirs) {
        const lines = [];
        for (const d of result.dirs)  lines.push(cyan(d + '/'));
        for (const f of result.files) lines.push(gray('  ') + f);
        return lines.join('\n') || dim('(empty)');
    }

    // tree
    if (result.treeLines != null) {
        return result.treeLines.join('\n') || dim('(empty)');
    }

    // status → grouped display
    if ('provider' in result && 'storagePath' in result) {
        return [
            '',
            `  ${bold('LLM')}`,
            row('Provider',    result.provider),
            row('Model',       result.model),
            row('Base URL',    result.baseUrl),
            '',
            `  ${bold('Storage')}`,
            row('Backend',     result.storage),
            row('Path',        result.storagePath),
            row('Config',      result.configFile),
            row('Files',       String(result.files)),
            row('Directories', result.directories?.length ? result.directories.join(', ') : '(none)'),
            '',
        ].join('\n');
    }

    // search results
    if (Array.isArray(result)) {
        if (result.length === 0) return dim('No results.');
        const query = result._query || '';
        return result.map(r => {
            if (!r.path) return JSON.stringify(r);
            const matchLines = (r.lines || [])
                .map(line => '  ' + highlightQuery(line, query))
                .join('\n');
            return `${bold(r.path)}\n${matchLines}`;
        }).join('\n\n');
    }

    // status actions
    if (result.status) return formatAction(result);

    // generic object → key: value
    const pad = Math.max(...Object.keys(result).map(k => k.length));
    return Object.entries(result)
        .map(([k, v]) => row(k.padEnd(pad), Array.isArray(v) ? v.join(', ') : String(v)))
        .join('\n');
}

function formatAction(result) {
    switch (result.status) {
        case 'initialized':
            return section(green('✓ Memory initialized'), [
                ['Backend', result.storage],
                ['Path',    result.path],
            ]);
        case 'written':
            return green(`✓ Written to ${result.path}`);
        case 'deleted':
            return green(`✓ Deleted ${result.path}`);
        case 'compacted': {
            const changed = result.filesChanged ?? 0;
            const total   = result.filesTotal ?? 0;
            const detail  = total > 0
                ? `\n\n    ${dim('Files reviewed')}   ${bold(String(total))}\n    ${dim('Files updated')}    ${bold(String(changed))}`
                : '';
            return green('✓ Memory compacted') + detail;
        }
        case 'processed':
            return section(green('✓ Facts extracted'), [
                ['Files updated', result.writeCalls],
            ]);
        case 'skipped':
            return dim('– Nothing to extract (conversation too short)');
        case 'imported':
            return section(green('✓ Chat history imported'), [
                ['Sessions',      result.sessions],
                ['Files updated', result.totalWriteCalls],
            ]);
        case 'exported':
            return section(green('✓ Memory exported'), [
                ['Files',  result.files],
                ['Format', result.format],
                ['Path',   result.path],
            ]);
        case 'cleared':
            return section(green('✓ Memory cleared'), [
                ['Files deleted', result.filesDeleted],
                ['Path',         result.path],
            ]);
        case 'logged_in':
            return section(green('✓ Logged in'), [
                ['Provider', result.provider],
                ['Config',   result.configFile],
            ]);
        case 'logged_in_interactive':
            return null; // already printed by the interactive prompt
        case 'error':
            return red(`✗ Extraction failed: ${result.error || 'unknown error'}`);
        default:
            return green(`✓ ${result.status}`);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────

function row(key, value) {
    return `    ${dim(key.padEnd(14))}  ${value}`;
}

function section(heading, rows) {
    if (!rows || rows.length === 0) return heading;
    const pad = Math.max(...rows.map(([k]) => String(k).length));
    const detail = rows
        .map(([k, v]) => `    ${dim(String(k).padEnd(pad))}   ${bold(String(v ?? ''))}`)
        .join('\n');
    return `${heading}\n\n${detail}`;
}

function highlightQuery(text, query) {
    if (!query) return text;
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(re, `\x1b[33;1m$1\x1b[0m`);
}

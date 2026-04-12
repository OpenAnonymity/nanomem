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
    return formatHuman(result, flags);
}

function formatHuman(result, flags) {
    if (result == null) return '';
    if (typeof result === 'string') return maybeRenderMarkdown(result, flags);

    // retrieve → print assembled context directly
    if (result.assembledContext != null) {
        return maybeRenderMarkdown(result.assembledContext, flags) || dim('No relevant context found.');
    }

    // read → print content directly
    if ('content' in result && 'path' in result) {
        return maybeRenderMarkdown(result.content ?? '', flags);
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
        case 'deleted_content':
            return result.deleteCalls > 0
                ? section(green('✓ Memory updated'), [['Facts removed', result.deleteCalls]])
                : dim('– Nothing matched');
        case 'skipped':
            return dim('– Nothing to extract (conversation too short)');
        case 'imported':
            return section(green('✓ Chat history imported'), [
                ['Sessions',      result.sessions],
                ['Files updated', result.totalWriteCalls],
            ]);
        case 'added':
            return section(green('✓ Text added to memory'), [
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

function maybeRenderMarkdown(text, flags = {}) {
    if (!text) return text;
    if (!process.stdout.isTTY) return text;
    if (!flags['render']) return text;
    return renderMarkdown(text);
}

function renderMarkdown(markdown) {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const rendered = [];
    let inFence = false;

    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            if (!inFence) rendered.push('');
            continue;
        }

        if (inFence) {
            rendered.push(`  ${gray(line)}`);
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            const text = renderInline(heading[2].trim());
            rendered.push(level <= 2 ? bold(text) : cyan(text));
            continue;
        }

        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            rendered.push(`${gray('│')} ${renderInline(quote[1])}`);
            continue;
        }

        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            const indent = ' '.repeat(Math.min(bullet[1].length, 6));
            rendered.push(`${indent}${cyan('•')} ${renderInline(bullet[2])}`);
            continue;
        }

        const numbered = /^(\s*)\d+\.\s+(.*)$/.exec(line);
        if (numbered) {
            const indent = ' '.repeat(Math.min(numbered[1].length, 6));
            rendered.push(`${indent}${cyan('•')} ${renderInline(numbered[2])}`);
            continue;
        }

        const rule = /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
        if (rule) {
            rendered.push(gray('────────────────────────'));
            continue;
        }

        rendered.push(renderInline(line));
    }

    return rendered.join('\n');
}

function renderInline(text) {
    if (!text) return text;

    let out = text;
    out = out.replace(/`([^`]+)`/g, (_, code) => gray(code));
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `${underline(label)} ${gray(`<${url}>`)}`);
    out = out.replace(/\*\*([^*]+)\*\*/g, (_, value) => bold(value));
    out = out.replace(/__([^_]+)__/g, (_, value) => bold(value));
    out = out.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, (_, prefix, value) => `${prefix}${dim(value)}`);
    out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_, prefix, value) => `${prefix}${dim(value)}`);
    return out;
}

function underline(text) {
    return col('\x1b[4m', text);
}

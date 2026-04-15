/**
 * Plain markdown file importer.
 *
 * Converts markdown files into sessions that can be fed to ingest().
 * Each file becomes a single-message conversation with the file content
 * as a user message, so the LLM extracts structured facts from it.
 *
 * Usage (library):
 *   import { parseMarkdownFiles } from '@openanonymity/nanomem/imports'
 *   const sessions = parseMarkdownFiles([{ path: 'notes/health.md', content: '...' }])
 *   for (const session of sessions) await mem.ingest(session.messages)
 *
 * Usage (CLI):
 *   memory import notes.md --format markdown
 *   memory import notes-dir/ --format markdown
 */
/** @import { Message, ChatGptSession } from '../../types.js' */

/**
 * Parse one or more markdown documents into sessions for ingestion.
 *
 * Accepts either a single markdown string or an array of { path, content } records
 * (e.g. from reading a directory of .md files).
 *
 * @param {string | { path: string; content: string }[]} input
 * @returns {ChatGptSession[]}
 */
export function parseMarkdownFiles(input) {
    if (typeof input === 'string') {
        return parseMarkdownString(input);
    }

    if (!Array.isArray(input) || input.length === 0) {
        throw new Error('Expected a markdown string or an array of { path, content } records.');
    }

    return input
        .filter(f => f.content && f.content.trim())
        .map(f => ({
            title: titleFromPath(f.path),
            messages: /** @type {Message[]} */ ([{ role: 'user', content: f.content.trim() }]),
            updatedAt: null,
        }));
}

/**
 * Split a single markdown string into sections by top-level headings.
 * If the document has multiple `# ` headings, each becomes a separate session.
 * Otherwise the whole string is a single session.
 */
function parseMarkdownString(input) {
    const trimmed = input.trim();
    if (!trimmed) return [];

    const sections = splitByTopHeadings(trimmed);

    if (sections.length <= 1) {
        return [/** @type {ChatGptSession} */ ({
            title: sections[0]?.heading ?? null,
            messages: /** @type {Message[]} */ ([{ role: 'user', content: trimmed }]),
            updatedAt: null,
        })];
    }

    return sections
        .filter(s => s.content.trim())
        .map(s => /** @type {ChatGptSession} */ ({
            title: s.heading,
            messages: /** @type {Message[]} */ ([{ role: 'user', content: s.content.trim() }]),
            updatedAt: null,
        }));
}

function splitByTopHeadings(text) {
    const lines = text.split('\n');
    /** @type {{ heading: string | null, content: string }[]} */
    const sections = [];
    /** @type {{ heading: string | null, lines: string[] }} */
    let current = { heading: null, lines: [] };

    for (const line of lines) {
        const match = line.match(/^#\s+(.*)/);
        if (match) {
            if (current.lines.length > 0 || current.heading) {
                sections.push({ heading: current.heading, content: current.lines.join('\n') });
            }
            current = { heading: match[1].trim() || null, lines: [] };
        } else {
            current.lines.push(line);
        }
    }

    if (current.lines.length > 0 || current.heading) {
        sections.push({ heading: current.heading, content: current.lines.join('\n') });
    }

    return sections;
}

function titleFromPath(filePath) {
    if (!filePath) return null;
    const name = filePath.split('/').pop() || '';
    return name.replace(/\.md$/i, '').replace(/[_-]/g, ' ').trim() || null;
}

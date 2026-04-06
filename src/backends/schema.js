/**
 * Memory index generation and bootstrap.
 */
/** @import { ExportRecord } from '../types.js' */

export function buildBootstrapIndex() {
    return `# Memory Index\n\n_No memories yet._\n`;
}

export function createBootstrapRecords(now = Date.now()) {
    return [
        {
            path: '_tree.md',
            content: buildBootstrapIndex(),
            oneLiner: 'Root index of memory filesystem',
            parentPath: '',
            createdAt: now,
            updatedAt: now
        }
    ];
}

export function buildTree(files) {
    const lines = ['# Memory Index', ''];

    if (files.length > 0) {
        for (const file of files) {
            const count = file.itemCount || 0;
            const updated = file.updatedAt
                ? new Date(file.updatedAt).toISOString().split('T')[0]
                : '';
            const meta = count > 0
                ? `(${count} item${count !== 1 ? 's' : ''}, updated ${updated})`
                : updated ? `(updated ${updated})` : '';
            lines.push(`- ${file.path} ${meta} — ${file.oneLiner}`);
        }
    } else {
        lines.push('_No files yet._');
    }

    return lines.join('\n');
}

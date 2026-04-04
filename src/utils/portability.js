/**
 * Portability utilities — convert memory state to/from portable formats.
 *
 * serialize(records)   → string      (line-delimited text, one file per block)
 * deserialize(str)     → records     (inverse of serialize)
 * toZip(records)       → Uint8Array  (valid ZIP archive, STORE mode, zero deps)
 *
 * `records` is the shape returned by backend.exportAll():
 *   [{ path: string, content: string }, ...]
 */

// ─── Text serialization ───────────────────────────────────────────────────────

const FILE_PREFIX = '--- FILE: ';

/**
 * Convert an array of {path, content} records into a single portable string.
 *
 * Format:
 *   --- FILE: path/to/file.md
 *   <file content>
 *   --- FILE: other/file.md
 *   <file content>
 *
 * Note: file content must not contain a line that starts with "--- FILE: ".
 * This is extremely unlikely for memory markdown but worth being aware of.
 */
export function serialize(records) {
    return records
        .filter(({ path }) => !path.endsWith('_index.md'))
        .map(({ path, content }) => `${FILE_PREFIX}${path}\n${content ?? ''}`)
        .join('\n');
}

/**
 * Reconstruct records from a serialized string produced by serialize().
 * @returns {{ path: string, content: string }[]}
 */
export function deserialize(str) {
    const records = [];
    const lines = str.split('\n');
    let currentPath = null;
    let currentLines = [];

    for (const line of lines) {
        if (line.startsWith(FILE_PREFIX)) {
            if (currentPath !== null) {
                records.push({ path: currentPath, content: currentLines.join('\n') });
            }
            currentPath = line.slice(FILE_PREFIX.length);
            currentLines = [];
        } else {
            if (currentPath !== null) currentLines.push(line);
        }
    }

    if (currentPath !== null) {
        records.push({ path: currentPath, content: currentLines.join('\n') });
    }

    return records;
}

// ─── ZIP archive ──────────────────────────────────────────────────────────────

// CRC-32 lookup table (built once at module load)
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();

function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** Little-endian 16-bit bytes */
function u16(n) { return [(n & 0xff), (n >> 8) & 0xff]; }
/** Little-endian 32-bit bytes */
function u32(n) { return [(n & 0xff), (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]; }

function concatU8(arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
}

/**
 * Produce a valid ZIP archive (STORE, no compression) from an array of records.
 * Works in Node.js ≥ 18 and modern browsers (uses TextEncoder + Uint8Array only).
 *
 * @param {{ path: string, content: string }[]} records
 * @returns {Uint8Array}
 */
export function toZip(records) {
    const enc = new TextEncoder();
    const localParts = [];   // raw bytes for local file entries
    const centralParts = []; // raw bytes for central directory entries
    let localOffset = 0;
    const filtered = records.filter(r => !r.path.endsWith('_index.md'));

    for (const { path, content } of filtered) {
        const name = enc.encode(path);
        const data = enc.encode(content ?? '');
        const checksum = crc32(data);
        const size = data.length;

        // Local file header (30 bytes) + name + data
        const localHeader = new Uint8Array([
            0x50, 0x4b, 0x03, 0x04, // signature
            0x14, 0x00,             // version needed: 2.0
            0x00, 0x00,             // flags
            0x00, 0x00,             // compression: STORE
            0x00, 0x00,             // mod time
            0x00, 0x00,             // mod date
            ...u32(checksum),
            ...u32(size),           // compressed size
            ...u32(size),           // uncompressed size
            ...u16(name.length),
            0x00, 0x00,             // extra field length
        ]);
        localParts.push(localHeader, name, data);

        // Central directory entry (46 bytes) + name
        const cdEntry = new Uint8Array([
            0x50, 0x4b, 0x01, 0x02, // signature
            0x14, 0x00,             // version made by: 2.0
            0x14, 0x00,             // version needed: 2.0
            0x00, 0x00,             // flags
            0x00, 0x00,             // compression: STORE
            0x00, 0x00,             // mod time
            0x00, 0x00,             // mod date
            ...u32(checksum),
            ...u32(size),           // compressed size
            ...u32(size),           // uncompressed size
            ...u16(name.length),
            0x00, 0x00,             // extra field length
            0x00, 0x00,             // file comment length
            0x00, 0x00,             // disk number start
            0x00, 0x00,             // internal attributes
            0x00, 0x00, 0x00, 0x00, // external attributes
            ...u32(localOffset),
        ]);
        centralParts.push(cdEntry, name);

        localOffset += localHeader.length + name.length + data.length;
    }

    const centralDir = concatU8(centralParts);

    // End of central directory record (22 bytes)
    const eocd = new Uint8Array([
        0x50, 0x4b, 0x05, 0x06, // signature
        0x00, 0x00,             // disk number
        0x00, 0x00,             // disk with central dir start
        ...u16(filtered.length), // entries on this disk
        ...u16(filtered.length), // total entries
        ...u32(centralDir.length),
        ...u32(localOffset),    // central dir offset
        0x00, 0x00,             // comment length
    ]);

    return concatU8([...localParts, centralDir, eocd]);
}

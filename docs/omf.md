# Open Memory Format (OMF) in `nanomem`

This document defines the Open Memory Format shape currently supported by
`@openanonymity/nanomem`.

Status:

- This is the canonical spec for the implementation in this repo.
- Version currently supported: `1.0`
- There is no separate external standards document wired into `nanomem` today.

## Purpose

OMF is a JSON format for exchanging memory state across tools without exposing
the internal storage backend shape.

In `nanomem`, OMF is used for:

- exporting the current memory filesystem to a portable JSON document
- previewing an incoming memory import
- importing an incoming memory document with duplicate detection and merge logic

It is intentionally higher-level than raw `storage.exportAll()` records.

## Top-Level Document

An OMF document is a JSON object with this shape:

```json
{
  "omf": "1.0",
  "exported_at": "2026-04-11T20:15:00.000Z",
  "source": {
    "app": "nanomem"
  },
  "memories": []
}
```

Fields:

- `omf`: required string version
- `exported_at`: required ISO datetime string
- `source.app`: optional producer identifier
- `memories`: required array of memory items

Validation rules:

- `omf` must be present
- `omf` must be one of the supported versions
- `memories` must be an array
- every memory item must be an object with non-empty string `content`

## Memory Item

Each `memories[]` entry has this logical shape:

```json
{
  "content": "Lives in Seattle",
  "category": "personal",
  "tags": ["housing"],
  "status": "active",
  "created_at": "2026-04-01",
  "updated_at": "2026-04-11",
  "expires_at": "2026-05-01",
  "extensions": {
    "nanomem": {
      "file_path": "personal/about.md",
      "heading": "General"
    }
  }
}
```

Supported fields:

- `content`: required string
- `category`: optional string
- `tags`: optional array of strings
- `status`: optional string
  - supported export values today: `archived`, `expired`
  - absence implies active/current
- `created_at`: optional `YYYY-MM-DD`
- `updated_at`: optional `YYYY-MM-DD`
- `expires_at`: optional `YYYY-MM-DD`
- `extensions`: optional object

## Extension Namespaces

`nanomem` currently writes:

```json
{
  "extensions": {
    "nanomem": {
      "file_path": "personal/about.md",
      "heading": "General"
    }
  }
}
```

For document-style exports it may write:

```json
{
  "extensions": {
    "nanomem": {
      "file_path": "notes/reference.md",
      "document": true
    }
  }
}
```

Import compatibility:

- `nanomem` import also accepts legacy `extensions["oa-chat"]`
- `file_path` from either namespace takes precedence when resolving the target file

## Export Semantics

The OMF export path converts the current memory filesystem into memory items.

Rules:

- internal `_tree.md` files are skipped
- empty files are skipped
- bullet-based markdown files export one OMF item per bullet
- non-bullet or document-style files export as a single memory item

Category derivation:

- start from the file path without `.md`
- strip trailing `/about`
- examples:
  - `personal/about.md` -> `personal`
  - `health/thyroid.md` -> `health/thyroid`
  - `projects/recipe-app.md` -> `projects/recipe-app`

Status derivation:

- expired bullet -> `status: "expired"`
- history/archive bullet -> `status: "archived"`
- active items omit `status`

Tag derivation:

- if a bullet topic differs from the topic inferred from file path, that topic is
  exported as a single tag

## Import Semantics

The import path is merge-oriented, not overwrite-oriented.

### Target Path Resolution

Import resolves each item to a target markdown file in this order:

1. `extensions.nanomem.file_path`
2. `extensions["oa-chat"].file_path`
3. `category`
4. fallback `personal/imported.md`

Category mapping rules:

- category containing `/` -> `<category>.md`
- single-segment category -> `<category>/about.md`

Examples:

- `personal` -> `personal/about.md`
- `health/thyroid` -> `health/thyroid.md`

### Document Detection

An item is treated as a document if either:

- `extensions.nanomem.document === true`
- `extensions["oa-chat"].document === true`
- `content.length > 500` and `content` contains a newline

Pure document groups write the last document item content directly to the target file.

### Bullet Import

Non-document items are converted to bullets and merged with existing file content.

Current mapping:

- `content` -> bullet text
- first tag, if present -> bullet topic
- `updated_at` -> bullet `updatedAt`
- `expires_at` -> bullet `expiresAt`
- `status: archived|expired` -> `history` section
- otherwise -> `long_term` section

After conversion:

- existing bullets and incoming bullets are combined
- duplicate detection is based on normalized fact text
- combined bullets are passed through compaction
- the file is rewritten with `renderCompactedDocument(...)`

This means import is semantic merge, not raw append.

## Preview Semantics

Preview performs a dry-run count without writing:

- `total`: total items in the OMF document
- `filtered`: items skipped because `includeArchived` is off
- `duplicates`: items whose normalized fact text already exists in the target file
- `toImport`: `total - filtered - duplicates`
- `newFiles`: number of new target files that would be created
- `existingFiles`: number of existing target files that would be merged into
- `byFile`: per-target-file counts

Document items count as new items in preview and are not duplicate-compared by bullet text.

## Import Options

Supported options:

```js
{ includeArchived?: boolean }
```

If `includeArchived` is `false`:

- items with `status === "archived"` are skipped
- items with `status === "expired"` are skipped

Default is `true`.

## Result Shapes

Preview result:

```json
{
  "total": 10,
  "filtered": 1,
  "toImport": 7,
  "duplicates": 2,
  "newFiles": 3,
  "existingFiles": 2,
  "byFile": {}
}
```

Import result:

```json
{
  "total": 10,
  "imported": 7,
  "duplicates": 2,
  "skipped": 1,
  "filesWritten": 4,
  "errors": []
}
```

## API Surface

In `nanomem`, OMF support is available through:

- `memoryBank.exportOmf()`
- `memoryBank.previewOmfImport(doc, options)`
- `memoryBank.importOmf(doc, options)`
- `validateOmf(doc)`
- `parseOmfText(text)`

Implementation:

- [src/omf.js](../src/omf.js)
- [src/index.js](../src/index.js)
- [src/browser.js](../src/browser.js)

## Compatibility Notes

- Import currently accepts both `extensions.nanomem` and legacy `extensions["oa-chat"]`
  for round-trip path preservation.
- Export currently writes `extensions.nanomem`.
- This spec is versioned. Any incompatible change should increment `omf` and
  preserve old-reader behavior where practical.

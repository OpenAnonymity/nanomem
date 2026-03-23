# Memory Conflict Resolution

This document describes how conflict resolution works in `@openanonymity/memory`.

## Why This Exists

Memory entries can contradict each other over time.

Examples:

- `User is vegetarian`
- `User likes steak`

These conflicts happen for a few common reasons:

1. The user's real-world state changed.
2. The user gave inconsistent statements at different times.
3. The model inferred something incorrectly.

The system should not treat all of those cases the same way.

## Metadata Model

Memory bullets can include two fields used for conflict resolution:

```md
- Fact text | topic=preferences | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2026-03-22
```

### `source`

Supported values:

- `user_statement`
- `assistant_summary`
- `inference`
- `system`

Intended meaning:

- `user_statement`: the user explicitly said it
- `assistant_summary`: the assistant restated a user claim faithfully
- `inference`: the model inferred it from context
- `system`: the application or system wrote it directly

### `confidence`

Supported values:

- `high`
- `medium`
- `low`

Default confidence follows source when omitted:

- `user_statement` -> `high`
- `assistant_summary` -> `medium`
- `system` -> `medium`
- `inference` -> `low`

## Resolution Policy

The runtime compaction layer applies these rules:

1. If a new explicit user statement contradicts an older explicit statement on the same topic, the newer user statement wins.
2. If a user statement conflicts with an inference, the user statement wins.
3. If two inferred facts conflict, the newer or higher-confidence inference wins.
4. If the conflict is ambiguous, keep both versions, but mark the weaker one `status=uncertain`.
5. Superseded or expired facts move to `History`.

## What Counts As A Conflict

The current implementation uses deterministic heuristics. It does not run full semantic reasoning over every pair of facts.

It currently detects:

- direct negation of the same claim
- opposite preferences on the same subject/object
- opposite sentiment claims such as `Python is great` vs `Python is terrible`
- diet-related contradictions and overlaps such as vegetarian vs meat-eating, and vegan vs vegetarian

This means the system is conservative. If a conflict is not recognized confidently, both facts may remain active unless other logic moves one to `History`.

## Outcomes

### Clear contradiction

Input:

```md
- I am vegetarian | topic=diet | source=user_statement | confidence=high | updated_at=2024-01-01
- I am not vegetarian | topic=diet | source=user_statement | confidence=high | updated_at=2025-01-01
```

Output:

```md
## Long-Term
- I am not vegetarian | topic=diet | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2025-01-01

## History
- I am vegetarian | topic=diet | tier=history | status=superseded | source=user_statement | confidence=high | updated_at=2024-01-01
```

### User statement beats inference

Input:

```md
- I am vegetarian | topic=diet | source=user_statement | confidence=high | updated_at=2025-01-01
- I like steak | topic=diet | source=inference | confidence=low | updated_at=2025-02-01
```

Output:

```md
## Long-Term
- I am vegetarian | topic=diet | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2025-01-01

## History
- I like steak | topic=diet | tier=history | status=superseded | source=inference | confidence=low | updated_at=2025-02-01
```

### Ambiguous overlap

Input:

```md
- I am vegan | topic=diet | source=user_statement | confidence=high | updated_at=2025-01-01
- I am vegetarian | topic=diet | source=assistant_summary | confidence=medium | updated_at=2025-01-02
```

Output:

```md
## Long-Term
- I am vegan | topic=diet | tier=long_term | status=active | source=user_statement | confidence=high | updated_at=2025-01-01
- I am vegetarian | topic=diet | tier=long_term | status=uncertain | source=assistant_summary | confidence=medium | updated_at=2025-01-02
```

## Where This Runs

Conflict handling is applied inside bullet compaction, which is used by:

- extraction-time merge logic
- explicit compaction runs
- normalization of generated bullet content

Relevant implementation files:

- `src/bullets/utils.js`
- `src/core/extractor.js`
- `src/core/compactor.js`

## Current Limitations

- Conflict detection is heuristic, not full semantic contradiction detection.
- Topic boundaries still matter; unrelated facts in the same file can reduce accuracy.
- Some real-world changes need explicit timestamps or clearer phrasing from the user for best results.

If stronger semantic conflict handling is needed later, the next step is adding an LLM-assisted conflict classifier on top of the current deterministic policy.

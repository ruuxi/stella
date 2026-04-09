# Dream — Memory Consolidation Protocol

Run this protocol periodically or on demand to consolidate scattered session signals into durable knowledge.

## When to Dream

- After a stretch of varied tasks (5+ notes entries without consolidation)
- When notes/ is growing but knowledge/ feels stale
- On explicit request

## Protocol

### 1. Orient

Read the full memory layer: `knowledge/index.md`, all `knowledge/` files, and recent `notes/` entries. Form hypotheses about what feels stale or missing. No searching yet.

### 2. Signal

Gather narrow, targeted evidence confirming suspected drift. Only check things you already suspect are relevant. Use available sources — files, project state, git history — but stay focused.

### 3. Consolidate

Merge findings into the knowledge layer:

- **Correct contradictions at source.** If a knowledge file says X but reality is Y, fix the file. Reality wins.
- **Promote durable insights from notes.** If a pattern appears across multiple task summaries, it belongs in knowledge.
- **Normalize dates.** Replace relative references ("last week") with absolutes.
- **Compress without destroying.** Test: would deletion cause worse future decisions? If no, cut it.
- **Prefer under-writing to overfitting.** One-off events and low-signal observations don't get promoted.

### 4. Prune and Index

Tighten memory for the next cold start:

- Remove stale entries from `knowledge/index.md`
- Add references to newly important files
- Delete knowledge files that are unused or derivable in seconds from live sources
- Verify the index matches actual files on disk

## Boundaries

- Dream only touches `knowledge/`, `knowledge/index.md`, and `registry.md`
- Never modify `notes/` or `raw/` — they are immutable records
- Never touch project code, tests, or config
- Log what was consolidated in the current day's notes entry

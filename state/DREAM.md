# Dream — Manual Skill Consolidation Protocol

Run this protocol periodically or on demand to review skill health and prune stale entries. This is a *manual* protocol the General agent can execute on request — it is separate from the background Dream agent that consolidates `thread_summaries` into `state/memories/MEMORY.md` automatically.

## When to Dream

- When `skills/` has entries that may be outdated, duplicated, or unused
- After a long stretch of work where `state/memories/MEMORY.md` shows recurring patterns that should be promoted into a skill
- On explicit request

## Protocol

### 1. Orient

Read the full skill layer: `skills/index.md`, every `skills/<name>/SKILL.md`. Skim `state/memories/MEMORY.md` for recent task patterns that may indicate drift. Form hypotheses about what feels stale or missing. No searching yet.

### 2. Signal

Gather narrow, targeted evidence confirming suspected drift. Only check things you already suspect are relevant. Use available sources — files, project state, git history — but stay focused.

### 3. Consolidate

Merge findings into the skills layer:

- **Correct contradictions at source.** If a `SKILL.md` says X but reality is Y, fix the file. Reality wins.
- **Promote durable insights from `MEMORY.md`.** If a pattern appears across multiple task blocks, it belongs in a skill.
- **Normalize dates.** Replace relative references ("last week") with absolutes.
- **Compress without destroying.** Test: would deletion cause worse future decisions? If no, cut it.
- **Prefer under-writing to overfitting.** One-off events and low-signal observations don't get promoted.

### 4. Review Skills

Evaluate the health and relevance of saved skills:

- **Fix broken skills.** If a skill with a `scripts/program.ts` has recent failures (check `failCount` in frontmatter when wired), investigate and update its program or `SKILL.md`.
- **Merge related skills.** If multiple entries solve overlapping problems (e.g., three Spotify helpers), consolidate into one cohesive skill.
- **Prune unused skills.** If a skill has never been read or invoked and is unlikely to be needed again, remove its folder.
- **Update stale approaches.** If the approach a skill encodes has changed (an app updated, an API changed), update both `SKILL.md` and any `scripts/program.ts`.
- **Demote brittle programs.** If a skill's `scripts/program.ts` keeps failing while the `SKILL.md` instructions still work, consider deleting the program and falling back to instruction-only.
- **Promote stable patterns.** If a skill has been re-derived from `SKILL.md` reliably across multiple sessions, freeze a `scripts/program.ts` so future runs skip the re-derivation cost. Future agents should run it as a plain shell entrypoint when the skill instructs them to do so.

### 5. Prune and Index

Tighten memory for the next cold start:

- Remove stale entries from `skills/index.md`
- Add references to newly important skills
- Delete skill folders that are unused or derivable in seconds from live sources
- Verify the index matches actual folders on disk
- Verify `registry.md` fast paths are current

## Boundaries

- This protocol touches `skills/`, `skills/index.md`, and `registry.md`
- Never modify `state/memories/` — that's owned by the background Dream agent
- Never modify `raw/` — it is an immutable record
- Never touch project code, tests, or config
- Your final assistant message should briefly summarize what skills you consolidated, merged, pruned, or promoted

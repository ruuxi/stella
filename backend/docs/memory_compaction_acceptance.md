# Memory + Compaction Acceptance Checklist

This checklist defines the intended behavior for orchestrator/subagent working memory and reminder injection.

## Working Memory

- [ ] Orchestrator thread compaction trigger is `80,000` tokens.
- [ ] Subagent thread compaction trigger is `140,000` tokens.
- [ ] Keep-recent tail target is `20,000` tokens (turn-aware boundary, not hard-cut mid-turn when avoidable).
- [ ] Compaction summary is preserved and re-injected as `[Thread context - prior work summary]`.

## Main Thread Rollover

- [ ] When `Main` is compacted, the conversation switches to a fresh active `Main` thread.
- [ ] New `Main` thread contains:
  - [ ] The compaction summary (`thread.summary`).
  - [ ] The retained post-compaction tail messages.
- [ ] Prior `Main` thread is archived after rollover.

## Reminder Injection

- [ ] Dynamic orchestrator reminders (device/thread/style/platform context) are only injected when:
  - [ ] Reminder content changed, or
  - [ ] Active thread changed (for example after compaction rollover).
- [ ] Dynamic reminder state is persisted per conversation (`orchestratorReminderHash`, `orchestratorReminderThreadId`).
- [ ] Subagents do not receive orchestrator-only dynamic reminder blocks.

## Recall + History

- [ ] `RecallMemories(source: "history")` continues to search `event_embeddings`.
- [ ] `event_embeddings` remain user/assistant message embeddings only.

## Microcompaction

- [ ] Event-history microcompaction remains enabled for orchestrator history assembly.
- [ ] `microcompact_boundary` events are appended when new trims occur.

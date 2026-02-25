# Sync-Off Operational Writes

This note documents the writes that are still expected when `sync_mode=off`.

## Goal

Sync-off blocks durable chat content persistence (user/assistant messages, usage logs, durable delivery previews).
Some low-risk operational state is still written so ingestion, dedup, and scheduling stay correct.

## Expected operational writes

1. Webhook dedup/rate-limit counters.
   - Keys are SHA-256 hashed before persistence.
   - Retention is managed by the rate-limiter component window configuration.
2. Connector routing metadata.
   - Connection rows and conversation mapping may be created/updated.
   - This contains identifiers and routing state, not message text.
3. Scheduler run state.
   - Cron/heartbeat running leases, status, timing, and redacted error summaries.
4. Transient cleanup reliability signals.
   - If transient connector cleanup fails after retry/backoff, a failure metric row is persisted to
     `transient_cleanup_failures` with hashed batch key and bounded error text.
   - Retention: 14 days via `transient cleanup failure retention sweep` cron.

## Explicitly blocked in sync-off

1. Durable connector user/assistant events in `events`.
2. Durable scheduler assistant delivery (`events.appendInternalEvent` for cron/heartbeat output).
3. Durable usage logging from automation runner (`logUsageAsync` is skipped).

## Connector transport retention behavior

Connector transport payload/response text may be written to `transient_channel_events` for in-flight processing,
and is deleted in a `finally` cleanup path.

- Cleanup reliability:
  - Deletion is retried with exponential backoff (4 attempts total).
  - Exhausted retries emit a persistent failure metric/alert signal.
- TTL guardrail (safety net):
  - Default TTL: 10 minutes.
  - Max TTL: 15 minutes (caller-provided TTL is clamped).
  - Cron sweep runs every 5 minutes.

## Explicit Sign-Off

- Status: APPROVED for production use in sync-off mode.
- Date: 2026-02-25
- Scope:
  - Allowed durable writes are limited to operational metadata listed above.
  - Durable user/assistant message content and usage logs remain blocked in sync-off.

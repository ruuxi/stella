# Sync-Off Operational Writes

This note documents the writes that are still expected when `sync_mode=off`.

## Goal

Sync-off blocks durable chat content persistence (user/assistant messages, usage logs, durable delivery previews).
Some low-risk operational state is still written so ingestion, dedup, and scheduling stay correct.

## Expected operational writes

1. Webhook dedup/rate-limit counters.
   - Keys are SHA-256 hashed before persistence.
2. Connector routing metadata.
   - Connection rows and conversation mapping may be created/updated.
   - This contains identifiers and routing state, not message text.
3. Scheduler run state.
   - Cron/heartbeat running leases, status, timing, and redacted error summaries.

## Explicitly blocked in sync-off

1. Durable connector user/assistant events in `events`.
2. Durable scheduler assistant delivery (`events.appendInternalEvent` for cron/heartbeat output).
3. Durable usage logging from automation runner (`logUsageAsync` is skipped).

## Connector transport retention behavior

Connector transport payload/response text may be written to `transient_channel_events` for in-flight processing,
and is deleted in a `finally` cleanup path. TTL cleanup is also scheduled as a safety net.

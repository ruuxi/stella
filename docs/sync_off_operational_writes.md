# Sync-Off Operational Writes

Sync-off blocks durable chat content persistence while Stella is handling transient channel delivery.

## Expected operational writes

- Ephemeral transient-batch storage used to fan messages through the connector pipeline
- Deduplication, rate-limit, and watchdog bookkeeping needed to deliver or retry work safely
- Cleanup-failure retention records so failed transient cleanup can be audited and purged later

## Explicitly blocked in sync-off

- Conversation message persistence for transient inbound traffic
- Durable event history writes for chat turns that should remain local-only
- Any storage path that would turn sync-off traffic into long-lived user content

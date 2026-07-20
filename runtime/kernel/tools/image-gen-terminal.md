# `image_gen` terminal lifecycle

`image_gen` is a normal terminal tool. A successful invocation does not finish
until its managed media job is terminal, every image has been copied into
`<stellaDataDir>/media/outputs/`, and each returned path names a non-empty file.
Failures return the gateway job ID, terminal status, stable error code, and
reason when available.

Managed submissions carry an owner-scoped `Idempotency-Key` derived from the
conversation and persisted model tool-call ID (not the ephemeral run ID). The
gateway reserves that key in Convex before contacting the provider. Repeating the same logical tool call
returns the existing job and never starts another generation. Reusing the key
with a different request is rejected.

Restart behavior is explicit:

- A renderer reload does not interrupt the runtime worker. The tool promise
  keeps polling, and the renderer reuses the deterministic job files when it
  reconnects.
- An Electron app or runtime-worker restart interrupts the in-memory promise and the original
  turn is recorded as interrupted; a dead process cannot later return a tool
  result. The Convex job continues independently and the renderer's existing
  materializer can still surface its artifact after restart. If an engine
  continuation replays the persisted tool-call identity, its POST reattaches
  and can receive the terminal result. A genuinely new tool-call identity is
  a new logical generation, so restart recovery and prompts must not invent a
  retry.
- A relay disconnect is equivalent to a lost submission response. The client
  retries the POST with the same key and receives the existing job.
- Previously persisted fire-and-forget `submitted` results remain readable.
  Their inline card still subscribes by `jobId` and materializes completion;
  they are not retroactively rewritten into terminal tool results.

User cancellation sends an independent DELETE using the same idempotency key,
then stops all polling and artifact work. A Convex cancellation tombstone makes
abort win even if DELETE reaches the gateway before POST reservation. Late
provider completion cannot resurrect a canceled job. Timeout is bounded at 20
minutes client-side; the gateway's image-only stale-job sweep fails abandoned
jobs after 15 minutes (plus sweep cadence), and the client cancels at its own
deadline so no later artifact appears.

These semantics apply only to the orchestrator/Fashion `image_gen` tool. Other
media clients do not send the idempotency key and retain their existing
submission behavior.

# `image_gen` terminal lifecycle

`image_gen` is a normal terminal tool. A successful invocation does not finish
until its managed media job is terminal, every image has been copied into
`<stellaDataDir>/media/outputs/`, and each returned path names a non-empty file.
Failures return the gateway job ID, terminal status, stable error code, and
reason when available.

Every `image_gen` provider choice routes through the managed gateway. The old
direct/BYOK OpenAI, Fal, and OpenRouter submission path is intentionally not
used because it had no crash-safe identity. The owner-scoped idempotency key is
derived from a durable local operation ID. That ID, its provider-job
attachment, terminal result, tool-call aliases, and delivery acknowledgement
live in `image-tool-operations.sqlite` under the Stella data directory.

The gateway atomically reserves the media job and a scheduled submission
outbox. Full inputs (including image-edit references) are envelope-encrypted;
the durable copy lives in Convex file storage while the first scheduled action
also carries the encrypted payload. A database CAS changes `pending` to
`dispatching` exactly once immediately before the Fal POST. Concurrent HTTP
retries and duplicate scheduled actions cannot pass that claim. `succeeded`,
`failed`, and `canceled` are immutable; late or opposite webhooks are audit-only.

Fal assigns `request_id` only after accepting a queue submission and exposes no
documented client submission idempotency key or lookup by a Stella key. This
leaves one irreducible boundary: a crash or connection loss after the durable
claim may leave it unknown whether Fal accepted the POST. Stella never repeats
that ambiguous POST. A webhook can still reconcile it; otherwise the job ends
as `SUBMISSION_OUTCOME_UNKNOWN` after a 15-minute unknown grace. A claim whose
action disappeared is first classified unknown after two minutes. Rows still in `pending` are
safe to reschedule because they provably never crossed the provider boundary.

Restart behavior is explicit:

- A renderer reload does not interrupt the runtime worker. The pending promise
  continues and the renderer reuses the deterministic job-index file.
- An Electron or runtime-worker restart interrupts the old promise and records
  the turn as interrupted, but the Convex job continues. A native, Claude, or
  Codex continuation reopens the operation ledger. It matches a persisted
  tool-call alias or, when an external process assigned a fresh ID, the same
  conversation and normalized request while work is pending or its terminal
  result is not yet persisted. It polls the attached job or returns the cached
  terminal result without another POST. Claude image identity uses the
  persisted Stella session key rather than the random MCP transport session.
- After Stella persists the tool-result transcript row, it acknowledges the
  operation as delivered. A later identical request with a new tool-call ID is
  then a genuinely new generation.
- A relay disconnect retries only the Stella HTTP request with the same durable
  key; it reattaches to the existing job.
- Legacy persisted fire-and-forget `submitted` results remain readable. Their
  existing inline card subscribes by `jobId`; they are not rewritten.

Cancellation persists a tombstone before provider cancellation and stops all
polling and artifact work. Late provider completion cannot resurrect the job.
The client timeout is 20 minutes; the gateway stale/unknown policy is 15
minutes plus sweep cadence.

Artifact downloads have their own aborting timeout within a 60-second handoff
grace. Runtime and renderer share a cross-process lock and publish only a fully
flushed temporary file through atomic rename, so one job/index produces one
complete local artifact.

These semantics apply only to `image_gen`. Other media behavior is unchanged.

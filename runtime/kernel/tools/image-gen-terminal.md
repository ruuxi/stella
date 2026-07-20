# `image_gen` terminal lifecycle

`image_gen` is a normal terminal tool. A successful invocation does not finish
until its selected provider operation is terminal, every image has been copied into
`<stellaDataDir>/media/outputs/`, and each returned path names a non-empty file.
Failures return the gateway job ID, terminal status, stable error code, and
reason when available.

`image_gen` honors the image provider saved in Settings. `stella` uses the
managed gateway. `openai`, `openrouter`, and `fal` use the user's locally saved
credential directly; reference images go only to that selected provider and
do not pass through Stella managed storage. Local references are restricted to
the active workspace and Stella attachment/media/output/Fashion roots, capped
at 20MB after the descriptor read, and fully decoded before use. Reference reads
use `O_NOFOLLOW`, reject files with multiple hardlinks, and compare two
descriptor-positioned byte snapshots plus device/inode/metadata before and
after the bounded read so path, ancestor, or same-size content replacement
cannot change the authorized object. Fashion's trusted picker stages references locally;
accepted HEIC files are converted with a 30-second macOS `sips` process limit;
missing/sandbox-denied conversion, oversized output, or an invalid JPEG fails
closed and cleans temporary files. Managed local references additionally require
explicit `allowManagedReferenceUpload` consent for the call.

The `image_gen` schema and runtime accept at most four references total across
paths and URLs. This count applies before provider selection. BYOK references
continue to travel directly to the selected provider. Managed-only local and
`data:image` references are normalized on-device when needed: the longest edge
is at most 1600 px, each transmitted image is at most 1 MiB, and decoded bytes
across all inline references are at most 2 MiB. Their combined data-URL text is
bounded to 2,796,460 characters; remote reference URLs are limited to 8 KiB.
Small already-valid images remain byte-identical, while larger images are
progressively downscaled and JPEG-encoded to preserve a useful reference within
the remaining aggregate budget.

The owner-scoped managed idempotency key is derived from a durable local
operation ID. That ID, its provider-job
attachment, terminal result, tool-call aliases, and delivery acknowledgement
live in `image-tool-operations.sqlite` under the Stella data directory.

The gateway envelope-encrypts full inputs (including image-edit references)
and writes them as bounded, owner- and operation-scoped Convex database chunks.
A manifest exists transactionally before the first chunk; only a complete
manifest can be attached to the atomically reserved media job and scheduled
submission outbox. This makes partial uploads enumerable and purgeable after
every crash boundary without a file-storage store-to-registration gap. A
database CAS changes `pending` to `dispatching` exactly once immediately before
the Fal POST. Concurrent HTTP retries and duplicate scheduled actions cannot
pass that claim. `succeeded`, `failed`, `canceled`, and `unknown` are immutable;
late or opposite webhooks are audit-only. Legacy jobs already backed by Convex
file storage remain readable and cleanable during migration; new durable image
submissions do not create those blobs.

The gateway rejects a declared or streamed request body above 3 MiB before JSON
parsing and independently repeats the four-item, 1 MiB-per-inline-image, and
2 MiB aggregate checks. Encrypted manifests are capped at 4.5 MiB of serialized
text. Dispatcher reconstruction is budgeted conservatively below Convex's
64 MiB action ceiling: two UTF-16 encrypted representations, three UTF-16
plaintext/provider-body representations, ciphertext and plaintext byte buffers,
and 8 MiB of fixed runtime headroom total 50.125 MiB at the hard limits. Chunk
arrays are released before decrypt/parse, and legacy storage bodies are streamed
through the same encrypted-payload cap.

Fal assigns `request_id` only after accepting a queue submission and exposes no
documented client submission idempotency key or lookup by a Stella key. This
leaves one irreducible boundary: a crash or connection loss after the durable
claim may leave it unknown whether Fal accepted the POST. Stella never repeats
that ambiguous POST. A webhook can still reconcile it; otherwise the job ends
with distinct terminal status `unknown` after a three-hour-fifteen-minute
reconciliation window (Fal's one-hour inference envelope plus two-hour webhook
retry envelope and a fifteen-minute scheduling margin).
A claim whose action disappeared is first classified unknown after two minutes. Rows still in `pending` are
safe to reschedule because they provably never crossed the provider boundary.

OpenAI Images, OpenRouter Images, and Fal queue submission expose no documented
caller idempotency/reconciliation key. BYOK therefore uses a local durable
at-most-once claim immediately before the direct POST. A returned Fal request
ID is stored and can be polled after restart. A crash or response loss after a
direct claim but before durable provider identity is an irreducible boundary:
the operation returns structured `provider_outcome_unknown` and is never
blindly resubmitted. This may lose one result, but cannot create a second charge.

Restart behavior is explicit:

- A renderer reload does not interrupt the runtime worker. The pending promise
  continues and the renderer reuses the deterministic job-index file.
- An Electron or runtime-worker restart interrupts the old promise and records
  the turn as interrupted. Managed work continues remotely; a BYOK Fal job can
  continue only after its returned request ID was durably attached. A native,
  Claude, or Codex continuation reopens the operation ledger using its stable,
  request-hashed tool-call alias. It polls the attached job or returns the cached
  terminal result without another POST. An exact durable engine/session/tool alias
  plus exact request hash always replays that terminal result, including after
  its prior response was acknowledged. A different native session/tool identity
  is a new intentional request even when the arguments are identical. Pre-canonical
  external aliases may reattach once by conversation and normalized request,
  then are durably promoted to the strict identity scheme. Claude uses the
  persisted stream-json `tool_use.id`. Stella reconstructs its exact arguments
  from `content_block_start` plus JSON deltas and binds it at block stop before
  Claude issues the MCP request; the finalized assistant transcript is a
  duplicate/fallback, never the first-call dependency. MCP request numbering is
  not identity. Codex uses the native
  `dynamicToolCall.id`/`item/tool/call.callId` within the persisted Codex
  session. Canonical request hashes are mismatch guards only. A new native ID
  is therefore a legitimate identical second generation; replay of the same
  native ID returns the same result even if transport sequencing changes.
- Native execution does not acknowledge inside the tool adapter. Only after
  Stella durably persists the tool-result transcript row does it acknowledge the
  operation as delivered. Claude acknowledges after the MCP HTTP response emits
  `finish`; Codex acknowledges after the app-server stdio write callback. A
  crash on either side of those boundaries may replay the same result, but the
  durable alias prevents another provider submission or charge.
- A relay disconnect retries only the Stella HTTP request with the same durable
  key. If every submission response is lost, the client performs authenticated,
  owner-scoped lookup by idempotency key and exact request hash until it finds
  the reserved job or reaches the terminal unknown deadline.
- Legacy persisted fire-and-forget `submitted` results remain readable. Their
  existing inline card subscribes by `jobId`; they are not rewritten.

Cancellation persists a managed tombstone before provider cancellation and
stops polling and artifact work. It is propagated as cancellation, not a
retryable error. Late provider completion cannot resurrect the job. The
managed client timeout is 3 hours 15 minutes; it does not auto-cancel accepted
work when that deadline becomes terminal `unknown`.

Artifact downloads have their own enforced aborting timeout within a 60-second
handoff grace. Runtime and renderer share a cross-process lock, fully decode
PNG/JPEG/GIF/WebP pixels before rename, reject corrupt or truncated bytes,
remove stale partials, fsync the file and parent directory, and
publish only through atomic rename. Payload publication is also keyed by job ID,
so transcript and completion-subscription convergence emits one artifact payload.
Managed and BYOK image bodies are byte-limited while streaming, before buffering.
Base64 length is checked before decoding, and encoded dimensions, total pixels,
animation frames, and worst-case decoded bytes are bounded before Photon/WASM
decode. Detected bytes—not a requested destination extension—select renderer
image validation.

Webhook dedup, terminal CAS, connector scheduling, and billing eligibility are
one Convex transaction. Only the transaction that changes a nonterminal job to
success schedules idempotent billing. Late success after cancel/unknown/timeout
is audit-only and never billed. Image connector delivery has a restart-durable
five-attempt watchdog and records terminal abandonment after exhaustion.

Encrypted managed inputs are deleted after submission settlement, cancellation,
terminal webhook processing, or unknown classification. Manifest rows retain
owner/job identity until every encrypted chunk deletion succeeds, so cleanup
can resume after any crash. Incomplete uploads are pruned after one hour;
complete unattached or provably unsubmitted pending manifests are abandoned
after 24 hours. The legacy file-storage cleanup outbox remains only for already
persisted jobs. Delivered local operation aliases are pruned after 30 days;
pending and undelivered terminal rows are retained for reattachment. Account
deletion first opens a durable owner media-purge gate, then drains jobs,
owner-tagged and legacy job-tagged webhook metadata, every partial or complete
encrypted manifest, legacy blob cleanup, and a durable provider-cancellation
outbox. Reservations and dispatch claims fail closed while that gate exists; an
in-flight accepted Fal request is retained until its provider ID can be
canceled. A claimed request whose provider acceptance is still ambiguous leaves
a sanitized canceled tombstone and makes account deletion fail closed for a
later retry rather than hot-looping or discarding the only reconciliation
handle. A late webhook may attach its provider ID only to the cancellation
outbox; it cannot reverse the terminal result or bill the user. If no provider
identity arrives, a later deletion retry removes the sanitized tombstone after
the same 3h15 provider reconciliation envelope expires. Local schema creation
and column migration run under `BEGIN IMMEDIATE` to serialize concurrent
desktop processes.

These semantics apply only to `image_gen`. Other media behavior is unchanged.

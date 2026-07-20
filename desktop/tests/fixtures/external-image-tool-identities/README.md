# External image tool identity fixtures

These are sanitized protocol-shaped captures from the opt-in installed adapter
probe on 2026-07-20. The probe used Claude Code 2.1.198 and Codex CLI 0.144.0,
both through Stella's production runtime adapters and their persisted
resume/session APIs. Image-provider submission was replaced by an in-process
terminal result; no image provider request, deployment, credential, prompt
history, or user file was captured.

The native IDs are retained because they are the behavior under test. Session,
thread, turn, message, timestamps, outputs, and prompts are sanitized. The
Claude capture records the stream-before-MCP ordering (`content_block_start`,
JSON delta, stop, then finalized assistant transcript). The Codex capture
records a changed JSON-RPC request number replaying the same native call ID and
a later intentional identical call with a new native ID.

Run the live certification probe explicitly with:

```sh
STELLA_RUN_INSTALLED_EXTERNAL_IMAGE_RESUME_PROBE=1 \
  vitest run tests/runtime/kernel/integrations/external-image-installed-resume.probe.test.ts
```

It requires locally installed, authenticated Claude and Codex CLIs. Normal test
runs skip it; the checked-in fixtures and production-path process harnesses are
the hermetic regression layer.

The live probe deliberately certifies one resumed conversation and an
intentional identical second invocation. Separate-conversation isolation,
changed transport sequencing, and exact crash/write boundaries remain in the
hermetic production-adapter harness: a third model-driven Codex conversation
is not deterministic enough for a certification test (the local 0.144.0 run
exceeded its 60-second probe bound), while the app-server protocol fixture and
correlator tests exercise those boundaries without another model response.

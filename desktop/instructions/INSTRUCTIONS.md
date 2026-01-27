---
invariants:
  - "Never expose provider or model identifiers in user-visible UI, logs, or client-returned Convex fields."
  - "Screens must render only within the right-panel Screen Host."
compatibilityNotes:
  - "Preserve the full and mini window modes."
  - "Ask mode uses screenshots only (no OCR, no recording)."
---

# Platform Instructions

This folder captures platform-level invariants that must remain true after self-modification,
pack installation, and upstream updates.


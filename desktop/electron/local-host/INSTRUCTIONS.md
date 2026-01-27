---
invariants:
  - "Change tracking and rollback must be programmatic and deterministic."
  - "Tool execution must remain device-routed using targetDeviceId."
  - "No provider/model identifiers may be written to client-visible Convex fields."
compatibilityNotes:
  - "Core tools must remain available: Read, Write, Edit, Glob, Grep, Bash, KillShell."
  - "Safe mode must be able to recover from broken self-modification or pack installs."
---

# Local Host Instructions

The Electron local host is the enforcement point for safety rails, change tracking,
pack application, and device routing.


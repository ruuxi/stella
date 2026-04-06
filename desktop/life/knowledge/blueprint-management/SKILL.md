---
name: Blueprint Management
description: Create shareable blueprints from features. Read when packaging, exporting, or publishing a feature reference.
---

# Blueprint Management

Use this entry when the user wants to package, export, publish, or share a feature as a reusable blueprint.

## Creating Blueprints

1. Ensure the feature is committed in Git with a stable `[feature:<id>]` tag.
2. Prepare:
   - `description`: a clear user-facing summary of what the feature does
   - `implementation`: a developer-facing explanation of how it was built
3. Use Stella's built-in export and share flow to publish the feature reference.

## Safety

- Always read files before modifying them so you understand existing patterns.
- Before risky multi-file edits, create a safety point in Git if the working tree is dirty.
- Use error boundaries for complex new components.
- When something breaks, prefer reverting a feature-tagged commit over ad hoc manual undo.

## Backlinks

- [Life Registry](../../registry.md)
- [Knowledge Index](../index.md)

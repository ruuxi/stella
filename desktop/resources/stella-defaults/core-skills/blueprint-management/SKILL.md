---
id: blueprint-management
name: Blueprint Management
description: Create shareable blueprints from features. Activate before blueprint operations.
agentTypes:
  - general
tags:
  - blueprint
  - self-mod
  - sharing
version: 1
---

# Blueprint Management

## Creating Blueprints

When the user wants to share a feature:
1. Ensure the feature is committed in Git with a stable `[feature:<id>]` tag.
2. Prepare:
   - `description`: clear user-facing summary of what the feature does
   - `implementation`: developer-facing explanation of how it was built
3. Use Stella's built-in export and share flow to publish the feature reference.

## Safety
- Always read files before modifying them so you understand existing patterns.
- Before risky multi-file edits, run `Bash("git stash push -u -m 'self-mod-prep'")` if the working tree is dirty.
- Use error boundaries for complex new components.
- When something breaks, use `git revert` on feature-tagged commits instead of ad hoc manual undo.

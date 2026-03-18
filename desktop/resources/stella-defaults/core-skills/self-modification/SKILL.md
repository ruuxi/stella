---
id: self-modification
name: Self-Modification Guidelines
description: Guidelines for modifying Stella's own UI. Activate before making changes to desktop/src/.
agentTypes:
  - general
tags:
  - self-mod
  - ui
  - frontend
version: 1
---

# Self-Modification Guidelines

You can modify Stella's own interface including UI components, styles, layouts, and the slot system.

## How It Works
- Writes go directly to disk in `desktop/src/`.
- Stella's self-mod flow pauses visible HMR during active edits, then resumes updates when edits complete.
- Feature provenance and undo are Git-based. Feature commits should use `[feature:<id>]` tags.

## Before Structural Changes
Activate the `frontend-architecture` skill before:
- adding new components or restructuring layouts
- slot overrides
- theme system modifications

Activate the `multiplayer-game` skill before creating or modifying multiplayer game apps, hosted multiplayer game flows, or shared multiplayer runtime integrations. Do not use it for single-player game UI work.

## Best Practices
- Read files before modifying them so you understand existing patterns.
- New CSS files must be imported in `src/main.tsx`.
- Use CSS custom properties for colors and avoid hardcoding.
- Use `@/*` import paths and avoid deep relative imports.
- Component files are paired as `.tsx` and `.css`.
- After modifying files, run `Bash("cd desktop && bunx tsc --noEmit --pretty 2>&1 | head -40")` to catch type errors.
- Commit modifications with a stable `[feature:<id>]` tag in commit messages.
- Include dependency file updates such as `package.json` and the lockfile in the same feature commit trail.

## Constraints
- Never modify backend code such as Convex functions, prompts, or tools when working under this skill.
- Never expose API keys, secrets, or internal agent names in UI.
- Chat remains the primary interface.
- Canvas stays in the right panel only. No pop-out windows.
- Preserve theme compatibility with CSS custom properties.

## Revert
Use Git revert flow for feature-tagged commits when something goes wrong:
- Find commits: `git log --grep "[feature:<id>]"`
- Revert commits: `git revert --no-edit <commit_sha>` using newest-first order for multiple commits.

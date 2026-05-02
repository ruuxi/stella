---
name: skill-creator
description: Create or update Stella skills under state/skills. Use when the user asks to add, revise, port, validate, document, or design reusable agent skills, skill instructions, skill scripts, skill references, or skill assets for Stella agents.
---

# Skill Creator

Use this skill to create or update skills for Stella agents.

## Stella Skill Shape

Skills live under `state/skills/<skill-name>/`.

Required:

- `SKILL.md` with YAML frontmatter containing only `name` and `description`.
- A concise Markdown body with the instructions another Stella agent should follow.

Optional:

- `scripts/` for deterministic helpers.
- `references/` for larger docs the agent should load only when needed.
- `templates/` for reusable starting points.
- `assets/` for files used in final outputs.
- `input.schema.json` or `output.schema.json` when schemas make the skill easier to use correctly.

Do not add auxiliary docs such as `README.md`, `CHANGELOG.md`, or installation guides unless the user explicitly asks for them.

## Principles

- Keep the skill small. Add only procedural knowledge, repo-specific facts, helper commands, or references that a capable agent would not reliably infer.
- Put trigger conditions in the frontmatter `description`; the body is loaded only after the skill triggers.
- Prefer one-level references linked directly from `SKILL.md`.
- Use scripts when repeated code would otherwise be rewritten often or when correctness depends on a fragile sequence.
- Use product-aligned language. Stella skills are for Stella agents, not generic Codex packaging.

## Creating a Skill

1. Clarify the real use cases with concrete examples when the request is vague.
2. Choose a lowercase hyphenated name under 64 characters.
3. Create `state/skills/<name>/SKILL.md`.
4. Add only the resource folders that are actually useful.
5. Validate frontmatter and folder shape.
6. Update `state/skills/index.md` when the new skill should be discoverable from the index.

When initializing from this skill's helper script, target Stella's skill root:

```bash
python3 state/skills/skill-creator/scripts/init_skill.py <skill-name> --path state/skills
```

The upstream helper also creates `agents/openai.yaml`. Stella does not require that file for skill discovery; remove it unless the UI explicitly needs it.

## Updating a Skill

1. Read the existing `SKILL.md` and any referenced resources.
2. Preserve useful instructions and delete stale or duplicative content.
3. Keep frontmatter to exactly:

```yaml
---
name: skill-name
description: Clear trigger and capability description.
---
```

4. Keep detailed reference material in `references/` instead of expanding `SKILL.md` indefinitely.
5. Validate scripts by running representative commands when they are changed.

## Validation

Run the bundled validator for basic frontmatter and naming checks:

```bash
python3 state/skills/skill-creator/scripts/quick_validate.py state/skills/<skill-name>
```

Also verify Stella's current catalog expectations in `runtime/kernel/shared/skill-catalog.ts` if discovery behavior is relevant to the task.

## Bundled References

- `references/openai_yaml.md` documents Codex/OpenAI UI metadata. Read it only if the user explicitly needs OpenAI-style skill metadata.
- `scripts/init_skill.py`, `scripts/quick_validate.py`, and `scripts/generate_openai_yaml.py` are copied from Codex's canonical skill-creator sample and may need Stella-specific cleanup when used for a strict Stella-only skill.

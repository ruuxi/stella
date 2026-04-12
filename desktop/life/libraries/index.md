# Libraries

`life/libraries/` holds reusable executable helpers for Stella code mode.

Each library should live in its own folder:

```text
life/libraries/<name>/
├── index.md
├── program.ts
├── input.schema.json
└── output.schema.json
```

## Rules

- Put human-facing docs, intent, examples, and caveats in `index.md`.
- Put executable logic in `program.ts`.
- Keep programs inspectable and deterministic.
- Library programs run in the same typed code-mode environment as `ExecuteTypescript`.
- Library programs receive their input as the global `input` value.
- Do not use `import`, `export`, `require`, `process`, or raw Node APIs inside `program.ts`.
- Return JSON-serializable data.

## When To Create One

- The same parser, transform, workflow helper, or reporting logic would otherwise be rewritten.
- The logic is stable enough to be reused across tasks.
- The helper benefits from having docs beside the executable code.

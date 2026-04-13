# Capabilities

`life/capabilities/` holds reusable executable capabilities that Stella builds over time.

Each capability lives in its own folder:

```text
life/capabilities/<name>/
├── index.md
├── program.ts
├── input.schema.json   (optional)
└── output.schema.json  (optional)
```

## Rules

- Put human-facing docs, intent, examples, and caveats in `index.md`.
- Put executable logic in `program.ts`.
- Capability programs run in the same full Node.js environment as `ExecuteTypescript`, with access to all Stella bindings: `workspace`, `life`, `shell`, `libraries`, `console`.
- Capability programs receive their input as the global `input` value.
- Use `shell.exec(command)` for running shell commands and Stella CLIs inside capability programs.
- Use `require()` or `await import()` for Node modules. Static `import`/`export` syntax is not supported (same as Code Mode).
- Return JSON-serializable data.
- Keep programs focused — one capability per entry.

## When To Create One

- You figured out how to do something non-obvious and want to remember the working approach.
- The same workflow, automation, or integration would otherwise be re-derived from scratch.
- The logic is stable enough to be called with `libraries.run(name, input)` in future tasks.
- A multi-step process (e.g., app control, data extraction, API workflow) should be a single callable unit.


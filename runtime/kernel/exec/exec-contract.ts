/**
 * Schemas and prompt guidance for the Codex-style `Exec` and `Wait` tools.
 *
 * Stella's agents see exactly two top-level entries for general work:
 *
 *   - `Exec`  — run an async TypeScript program in a long-lived V8 context.
 *               Capabilities are exposed as `tools.<name>` entries built from
 *               the registry; built-in globals (`text`, `image`, `store`,
 *               `load`, `notify`, `yield_control`, `exit`) stay tiny and
 *               stable.
 *
 *   - `Wait`  — resume a yielded `Exec` cell that backgrounded itself with
 *               `// @exec: yield_after_ms=…`.
 *
 * The description is built dynamically per-turn from the registry so adding a
 * new tool only needs a registry change — no prompt or runtime edit.
 */

import {
  renderJsonSchemaAsTypescript,
  type ExecToolDefinition,
} from "../tools/registry/registry.js";

export const EXEC_TOOL_NAME = "Exec";
export const WAIT_TOOL_NAME = "Wait";

export const EXEC_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "One short line describing what the program will accomplish. Shown to the user before execution.",
    },
    source: {
      type: "string",
      description:
        "Async TypeScript program body. Top-level await and return are allowed. Use `tools.<name>(...)` for capabilities, `text(...)` / `image(...)` to return rich content, `store(...)` / `load(...)` for cross-call state, and `// @exec: yield_after_ms=…` to yield control to `Wait`.",
    },
    timeoutMs: {
      type: "number",
      description:
        "Optional execution timeout in milliseconds. Defaults to 30000, max 120000.",
    },
  },
  required: ["summary", "source"],
} as const;

export const WAIT_JSON_SCHEMA = {
  type: "object",
  properties: {
    cell_id: {
      type: "string",
      description:
        "Cell id of the yielded `Exec` invocation to resume. Returned in the previous `Exec` result when the program issued `// @exec: yield_after_ms=…` or called `yield_control()`.",
    },
    yield_after_ms: {
      type: "number",
      description:
        "How long to wait for new output before yielding again (default 10000).",
    },
    terminate: {
      type: "boolean",
      description: "When true, terminates the running cell instead of resuming it.",
    },
  },
  required: ["cell_id"],
} as const;

const EXEC_BASE_DESCRIPTION = `Run an async TypeScript program in Stella's persistent V8 runtime.

Use Exec for everything that isn't a direct UI prompt (AskUserQuestion / RequestCredential): file reads/writes, edits, shell commands, browser/desktop automation, office documents, web fetches, scheduling, task delegation, display rendering, memory mutations, skill usage, and arbitrary code logic.

Programming model:
- Write a program body, not a full module. Top-level await and return are allowed.
- The runtime is a long-lived V8 context with full Node globals (Buffer, fetch, process). Static \`import\`/\`export\` are not supported — use \`require()\` or \`await import()\`.
- All capabilities live on the global \`tools\` object: \`await tools.read_file({ path })\`, \`await tools.shell({ command })\`, etc.
- Some tools' full typed signatures are omitted from this description to save tokens. Every callable tool is listed in \`ALL_TOOLS\` (an array of \`{ name, description }\`). Filter \`ALL_TOOLS\` by name/description to discover tools you don't already know about; never print the entire array. To see a deferred tool's argument schema, call \`await tools.describe({ name: "<tool>" })\`.
- Return any JSON-serializable value, OR call \`text(...)\` / \`image(...)\` to send rich content items back to the model.

Built-in globals:
- \`text(value)\` — append a text content item. Useful when you want the model to see prose alongside structured data.
- \`image(pathOrBuffer, { mime? })\` — append an image content item from an absolute path or a Buffer. Mirrors how stella-computer attaches screenshots.
- \`store(key, value)\` / \`load(key)\` — persist values across Exec calls within the same session (a key/value scratchpad that survives until the conversation ends).
- \`notify(text)\` — stream a status line back to the user without ending the program.
- \`yield_control()\` — yield immediately so the agent can call \`Wait\` and continue later. The header pragma \`// @exec: yield_after_ms=2000\` does the same after a delay.
- \`exit(value?)\` — finish the program early with an explicit return value.

Editing files:
- Prefer \`tools.apply_patch({ patch })\` over \`tools.write_file\` for any change to an existing file. The patch format is plain text:
\`\`\`
*** Begin Patch
*** Update File: /abs/path/to/file
@@
-old line
+new line
*** End Patch
\`\`\`
  Operations: \`*** Add File: <path>\`, \`*** Update File: <path>\` (with optional \`*** Move to: <path>\`), \`*** Delete File: <path>\`. For Update hunks, prefix unchanged context lines with a single space.

Long-running work:
- Background a shell with \`tools.shell({ command, background: true })\` to get back a \`shell_id\` immediately, then poll with \`tools.shell({ op: 'status', shell_id })\` or stop with \`tools.shell({ op: 'kill', shell_id })\`.
- For long-running programs, add \`// @exec: yield_after_ms=2000\` to the very first line of the source. The cell yields back to the agent; resume it with \`Wait({ cell_id })\` from the next turn.

Paths:
- Absolute paths are required. There is no implicit workspace restriction — \`tools.read_file({ path })\` and \`tools.write_file({ path })\` operate anywhere on the filesystem.
- For repo-relative work, build the absolute path yourself (e.g. \`require("path").resolve(process.cwd(), "src/foo.ts")\`).

Skills:
- Stella's skills live under \`state/skills/<name>/SKILL.md\`. When the skill library is small, each turn includes a full \`<skills>\` catalog summarizing the saved skills.
- When the library grows too large to inline, the prompt may include only a compact skills block and the runtime may automatically prepend \`<explore_findings>\` for General tasks to surface the most relevant skill paths.
- Read the relevant \`SKILL.md\` with \`tools.read_file({ path })\`. If a skill instructs you to use \`scripts/program.ts\`, run it as a plain shell command via \`tools.shell({ command: "bun /abs/path/to/state/skills/<name>/scripts/program.ts" })\`.

Return value:
- The structured \`return\` value (when JSON-serializable) is what the agent sees. \`text(...)\` / \`image(...)\` items are appended on top.
- When the program ends without a \`return\`, the result is whatever was sent through \`text\` / \`image\`.`;

export const buildExecToolDescription = (
  enabledTools: readonly ExecToolDefinition[],
): string => {
  if (enabledTools.length === 0) {
    return EXEC_BASE_DESCRIPTION;
  }

  // Tier 1: tools whose typed signatures ship in the prompt every turn.
  // Tier 2 (deferred): listed only in `ALL_TOOLS`. The model fetches their
  // schemas on demand via `tools.describe({ name })`.
  const tier1 = enabledTools.filter((tool) => !tool.defer);
  const deferredCount = enabledTools.length - tier1.length;

  const sections: string[] = [EXEC_BASE_DESCRIPTION, ""];
  sections.push("Available tools (`tools.*`):");
  sections.push("```ts");
  sections.push("declare const tools: {");
  for (const tool of tier1) {
    const inputType = renderJsonSchemaAsTypescript(tool.inputSchema);
    const outputType = tool.outputSchema
      ? renderJsonSchemaAsTypescript(tool.outputSchema)
      : "unknown";
    const description = tool.description.split("\n")[0]?.trim() ?? "";
    if (description) {
      sections.push(`  /** ${description.slice(0, 200)} */`);
    }
    sections.push(`  ${tool.name}(args: ${inputType}): Promise<${outputType}>;`);
  }
  sections.push("  // ...plus every deferred tool listed in ALL_TOOLS.");
  sections.push("  [name: string]: (args: unknown) => Promise<unknown>;");
  sections.push("};");
  sections.push(
    "declare const ALL_TOOLS: ReadonlyArray<{ name: string; description: string }>;",
  );
  sections.push("```");

  if (deferredCount > 0) {
    sections.push("");
    sections.push(
      `Deferred tools (${deferredCount}): omitted from the typed signatures above to save prompt tokens. Filter \`ALL_TOOLS\` by name/description to find one, then either call it directly (\`await tools.<name>(args)\`) or fetch its full schema first with \`await tools.describe({ name: "<tool>" })\`. Never print the full \`ALL_TOOLS\` array; print only the small set of relevant matches.`,
    );
  }

  return sections.join("\n");
};

export const WAIT_TOOL_DESCRIPTION = `Resume a yielded \`Exec\` cell.

Use Wait when a previous Exec invocation yielded back (either because the program issued \`yield_control()\` / \`// @exec: yield_after_ms=…\`, or because it backgrounded long-running work via \`tools.shell({ background: true })\`).

- \`cell_id\`: the id returned by the previous \`Exec\` result.
- \`yield_after_ms\`: how long to keep waiting for new output before yielding again. Defaults to 10000.
- \`terminate\`: set true to forcibly stop the running cell instead of resuming it.

The result mirrors \`Exec\`'s output (return value plus any \`text(...)\` / \`image(...)\` content items). The same \`cell_id\` may be resumed multiple times until the program returns or terminates.`;

export const buildExecPromptGuidance = (
  enabledTools: readonly ExecToolDefinition[],
): string => {
  return [
    `Code mode (Codex-style):`,
    `- ${EXEC_TOOL_NAME} is the only general-purpose tool. Everything except direct UI prompts (AskUserQuestion / RequestCredential) goes through it.`,
    `- Capabilities are on the global \`tools\` object. Discover unknowns with \`ALL_TOOLS\` (filter by name/description; never dump the whole array).`,
    `- Return a JSON-serializable value AND/OR append rich items via \`text(value)\` / \`image(path)\`.`,
    `- Edits should use \`tools.apply_patch({ patch })\` with the \`*** Begin Patch\` format.`,
    `- For long-running work, set \`// @exec: yield_after_ms=…\` and resume with ${WAIT_TOOL_NAME}({ cell_id }).`,
    ``,
    buildExecToolDescription(enabledTools),
  ].join("\n");
};

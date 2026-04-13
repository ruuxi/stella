export const EXECUTE_TYPESCRIPT_TOOL_NAME = "ExecuteTypescript";

export const EXECUTE_TYPESCRIPT_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "Short description of what the program will do before it runs.",
    },
    code: {
      type: "string",
      description:
        "TypeScript program body to execute. Top-level await and return are allowed.",
    },
    timeoutMs: {
      type: "number",
      description:
        "Optional execution timeout in milliseconds. Defaults to 30000, max 120000.",
    },
  },
  required: ["summary", "code"],
} as const;

export const EXECUTE_TYPESCRIPT_TOOL_DESCRIPTION =
  "Write and run a short TypeScript program in a full Node.js runner with Stella helpers.\n\n" +
  "Use this when the task needs loops, batching, Promise.all, aggregation, parsing, or exact math in one step instead of many separate tool calls.\n\n" +
  "Rules:\n" +
  "- Write a program body, not a full module. Top-level await and return are allowed.\n" +
  "- The program runs with full Node.js capabilities, including Buffer, process, require(), and fetch.\n" +
  "- Because this is a program body, static import/export syntax is not supported. Use require() or await import() instead.\n" +
  "- Use the provided bindings instead: workspace, life, shell, libraries, console.\n" +
  "- Always use shell.exec(command, options?) for running shell commands. Do not use child_process.exec/spawn directly — Stella CLI wrappers (stella-browser, stella-office, stella-ui) are only available through shell.exec.\n" +
  "- Return JSON-serializable data. Keep code focused and deterministic.\n" +
  "- Before solving from scratch, check life/capabilities/ for an existing capability with libraries.list() or libraries.run(name, input).";

export const EXECUTE_TYPESCRIPT_PROMPT_GUIDANCE = `
Code mode:
- Prefer \`${EXECUTE_TYPESCRIPT_TOOL_NAME}\` when work needs batching, loops, Promise.all, exact math, aggregation, or deterministic transforms.
- Write a short async TypeScript program body. Top-level await and return are allowed.
- The program runs in a full Node.js subprocess with Buffer, process, require(), fetch, and other standard Node APIs available.
- Static import/export syntax is not supported inside program bodies. Use require() or await import() instead.
- Use the provided globals instead, and return JSON-serializable data.
- Always use shell.exec() for running commands. Do not use child_process directly — Stella CLI wrappers (stella-browser, stella-office, stella-ui) are only available through shell.exec.
- Before solving from scratch, check life/capabilities/ for existing capabilities with libraries.list() or libraries.run(name, input).

Available globals:
\`\`\`ts
declare const workspace: {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<{ path: string; created: boolean }>;
  replaceText(args: {
    path: string;
    oldText: string;
    newText: string;
    replaceAll?: boolean;
  }): Promise<{ path: string; replacements: number }>;
  search(args: {
    pattern: string;
    path?: string;
    glob?: string;
    type?: string;
    mode?: "content" | "files" | "count";
    caseInsensitive?: boolean;
    contextLines?: number;
    maxResults?: number;
  }): Promise<
    | { mode: "files"; files: string[] }
    | { mode: "count"; counts: Array<{ path: string; count: number }> }
    | { mode: "content"; text: string }
  >;
  glob(pattern: string, args?: { path?: string }): Promise<string[]>;
  gitStatus(args?: { path?: string; short?: boolean }): Promise<string>;
  gitDiff(args?: { path?: string; staged?: boolean; base?: string }): Promise<string>;
};

declare const life: {
  read(pathOrSlug: string): Promise<string>;
  list(area?: "knowledge" | "notes" | "raw" | "outputs" | "capabilities"): Promise<string[]>;
  search(query: string, args?: { area?: "knowledge" | "notes" | "raw" | "outputs" | "capabilities"; maxResults?: number }): Promise<Array<{
    path: string;
    line: number;
    text: string;
  }>>;
};

declare const shell: {
  exec(
    command: string,
    options?: {
      description?: string;
      workingDirectory?: string;
      timeoutMs?: number;
    },
  ): Promise<string>;
};

declare const libraries: {
  list(): Promise<Array<{ name: string; path: string; hasProgram: boolean; description?: string }>>;
  read(name: string): Promise<{
    name: string;
    path: string;
    description?: string;
    docs?: string;
    program?: string;
  }>;
  run(name: string, input?: unknown): Promise<unknown>;
};

declare const console: {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
\`\`\`

Examples:
\`\`\`ts
await shell.exec("stella-browser open https://outlook.office.com");
const snapshot = await shell.exec("stella-browser snapshot -i");
const report = await shell.exec("stella-office view report.docx text");
\`\`\`

life model:
- \`life/knowledge/\` stores human-readable manuals, workflows, and reference docs.
- \`life/capabilities/<name>/\` stores reusable executable capabilities. Each has:
  - \`index.md\` for docs (what it does, when to use it, approach used)
  - \`program.ts\` for executable logic (full Node.js + Stella bindings)
  - optional \`input.schema.json\` and \`output.schema.json\`
- Use \`libraries.run(name, input)\` when a reusable capability already exists.
- After succeeding at something non-trivial, save the working approach as a new library.
`.trim();

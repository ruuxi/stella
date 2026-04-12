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
  "Write and run a short TypeScript program against Stella's typed bindings.\n\n" +
  "Use this when the task needs loops, batching, Promise.all, aggregation, parsing, or exact math in one step instead of many separate tool calls.\n\n" +
  "Rules:\n" +
  "- Write a program body, not a full module. Top-level await and return are allowed.\n" +
  "- Do not use import, export, require, process, child_process, or direct filesystem/network APIs.\n" +
  "- Use the provided bindings instead: workspace, life, browser, office, shell, libraries, console.\n" +
  "- Return JSON-serializable data. Keep code focused and deterministic.\n" +
  "- Prefer workspace/life/browser/office bindings over raw shell. Keep shell.exec as the escape hatch.";

export const EXECUTE_TYPESCRIPT_PROMPT_GUIDANCE = `
Code mode:
- Prefer \`${EXECUTE_TYPESCRIPT_TOOL_NAME}\` when work needs batching, loops, Promise.all, exact math, aggregation, or deterministic transforms.
- Write a short async TypeScript program body. Top-level await and return are allowed.
- Do not use import, export, require, process, child_process, fetch, or raw Node APIs inside the program.
- Use the provided globals instead, and return JSON-serializable data.

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
  list(area?: "knowledge" | "notes" | "raw" | "outputs" | "libraries"): Promise<string[]>;
  search(query: string, args?: { area?: "knowledge" | "notes" | "raw" | "outputs" | "libraries"; maxResults?: number }): Promise<Array<{
    path: string;
    line: number;
    text: string;
  }>>;
};

declare const browser: {
  open(url: string): Promise<string>;
  snapshot(args?: { interactive?: boolean; compact?: boolean; depth?: number; selector?: string }): Promise<string>;
  click(target: string): Promise<string>;
  fill(target: string, value: string): Promise<string>;
  getText(target: string): Promise<string>;
  wait(args: { ms?: number; text?: string; url?: string; load?: "load" | "domcontentloaded" | "networkidle"; fn?: string; timeoutMs?: number } | number): Promise<string>;
};

declare const office: {
  view(file: string, mode: "outline" | "stats" | "issues" | "text" | "annotated", args?: {
    type?: "format" | "content" | "structure";
    limit?: number;
    start?: number;
    end?: number;
    maxLines?: number;
  }): Promise<string>;
  get(file: string, path: string, args?: { depth?: number; json?: boolean }): Promise<unknown>;
  query(file: string, selector: string, args?: { json?: boolean }): Promise<unknown>;
  set(file: string, path: string, props: Record<string, string | number | boolean | null>): Promise<string>;
  validate(file: string, args?: { json?: boolean }): Promise<unknown>;
};

declare const shell: {
  exec(args: {
    command: string;
    description?: string;
    workingDirectory?: string;
    timeoutMs?: number;
  }): Promise<string>;
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

life model:
- \`life/knowledge/\` stores human-readable manuals, workflows, and reference docs.
- \`life/libraries/<name>/\` stores reusable executable memory. Prefer:
  - \`index.md\` for docs
  - \`program.ts\` for executable logic
  - optional \`input.schema.json\` and \`output.schema.json\`
- Use \`libraries.run(name, input)\` when a reusable life library already exists.
`.trim();

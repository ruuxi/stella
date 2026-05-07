/**
 * Store-thread prompt + publish-time commit helpers.
 *
 * Pulled out of `runtime/worker/server.ts` because they are pure /
 * filesystem-level utilities that don't touch worker state, and they
 * collectively account for ~300 lines of the worker's bulk.
 *
 * - `normalizeStoreThreadText` / `normalizeStoreThreadFeatureNames`
 *   gate the IPC payload going into the Store agent.
 * - `extractBlueprintMarkdown` parses the agent's final text for the
 *   blueprint envelope (fenced ```blueprint or legacy
 *   <blueprint>...</blueprint>).
 * - `buildStoreThreadAgentPrompt` builds the curated prompt sent to
 *   the local Store agent for each turn.
 * - `runStoreReleaseGitShow`, `buildStoreReleaseRedactor`, and
 *   `collectStoreReleaseCommits` produce per-commit reference diffs
 *   for the Store publish pipeline, with a best-effort redactor.
 */
import os from "node:os";
import { exec as gitExec } from "dugite";
import type { StoreReleaseCommit } from "../contracts/index.js";
import type { StoreModStore } from "../kernel/storage/store-mod-store.js";

export const STORE_THREAD_CONVERSATION_ID = "store-agent-local";
const STORE_THREAD_MAX_USER_TEXT = 8_000;

export const normalizeStoreThreadText = (value: unknown): string => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error("Message text is required.");
  }
  if (text.length > STORE_THREAD_MAX_USER_TEXT) {
    throw new Error("Message is too long.");
  }
  return text;
};

export const normalizeStoreThreadFeatureNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];

export const extractBlueprintMarkdown = (
  finalText: string,
): { blueprintMarkdown: string | null; visibleText: string } => {
  // Preferred: fenced ```blueprint block. Backreference on the fence
  // length lets the LLM pick 4+ backticks when the blueprint itself
  // contains triple-backtick code blocks.
  const fenced = finalText.match(
    /(`{3,})blueprint[^\n]*\n([\s\S]*?)\n\1\s*(?:\n|$)/i,
  );
  if (fenced) {
    const blueprintMarkdown = (fenced[2] ?? "").trim();
    const visibleText = finalText
      .replace(fenced[0], "")
      .replace(/<message>\s*([\s\S]*?)\s*<\/message>/i, "$1")
      .trim();
    return {
      blueprintMarkdown: blueprintMarkdown || null,
      visibleText,
    };
  }
  // Tolerate the legacy <blueprint>...</blueprint> envelope so older
  // model outputs (or hand-typed examples) still parse.
  const tagged = finalText.match(/<blueprint>\s*([\s\S]*?)\s*<\/blueprint>/i);
  if (tagged) {
    const blueprintMarkdown = (tagged[1] ?? "").trim();
    const visibleText = finalText
      .replace(tagged[0], "")
      .replace(/<message>\s*([\s\S]*?)\s*<\/message>/i, "$1")
      .trim();
    return {
      blueprintMarkdown: blueprintMarkdown || null,
      visibleText,
    };
  }
  return { blueprintMarkdown: null, visibleText: finalText.trim() };
};

// Paths that carry no signal for the published reference diffs and
// routinely dwarf real changes. Excluded from `git show` via pathspec
// so both the patch and the --stat header skip them.
const STORE_RELEASE_GIT_SHOW_EXCLUDE_PATHSPECS = [
  ":(exclude,glob)**/bun.lock",
  ":(exclude,glob)**/package-lock.json",
  ":(exclude,glob)**/pnpm-lock.yaml",
  ":(exclude,glob)**/yarn.lock",
  ":(exclude,glob)**/Cargo.lock",
  ":(exclude,glob)**/*.min.js",
  ":(exclude,glob)**/*.min.css",
  ":(exclude,glob)**/dist/**",
  ":(exclude,glob)**/dist-electron/**",
  ":(exclude,glob)**/build/**",
  ":(exclude,glob)state/electron-user-data/**",
  ":(exclude,glob)**/*.snap",
];

const STORE_RELEASE_PER_COMMIT_DIFF_LIMIT = 200_000;

const runStoreReleaseGitShow = async (
  repoRoot: string,
  commitHash: string,
): Promise<{ subject: string; diff: string }> => {
  if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) {
    throw new Error(`Invalid commit hash: ${commitHash}`);
  }
  const subjectResult = await gitExec(
    ["show", "-s", "--format=%s", "--no-color", commitHash],
    repoRoot,
    { encoding: "utf8", maxBuffer: 1 * 1024 * 1024 },
  );
  const subjectStdout =
    typeof subjectResult.stdout === "string"
      ? subjectResult.stdout
      : Buffer.from(subjectResult.stdout).toString("utf8");
  if (subjectResult.exitCode !== 0) {
    throw new Error(
      `Unable to read ${commitHash}: git exited ${subjectResult.exitCode}`,
    );
  }
  const subject = subjectStdout.trim() || `(no subject)`;
  const diffResult = await gitExec(
    [
      "show",
      "-U10",
      "--patch",
      "--find-renames",
      "--no-color",
      commitHash,
      "--",
      ...STORE_RELEASE_GIT_SHOW_EXCLUDE_PATHSPECS,
    ],
    repoRoot,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const diffStdout =
    typeof diffResult.stdout === "string"
      ? diffResult.stdout
      : Buffer.from(diffResult.stdout).toString("utf8");
  if (diffResult.exitCode !== 0) {
    throw new Error(
      `Unable to read ${commitHash}: git exited ${diffResult.exitCode}`,
    );
  }
  const trimmed = diffStdout.trim() || `(empty commit ${commitHash})`;
  const diff =
    trimmed.length <= STORE_RELEASE_PER_COMMIT_DIFF_LIMIT
      ? trimmed
      : `${trimmed.slice(0, STORE_RELEASE_PER_COMMIT_DIFF_LIMIT)}\n... [truncated]`;
  return { subject, diff };
};

/**
 * Best-effort redactor for text leaving the author's machine. Scrubs
 * `$HOME` paths, the local username when it appears in path-shaped
 * contexts, JWT/OAuth/SSH credential shapes, email addresses outside
 * obvious test fixtures, and bearer-token assignments. The reviewer
 * still rejects on anything the regex misses.
 */
export const buildStoreReleaseRedactor = (): ((input: string) => string) => {
  const home = os.homedir();
  const username = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return null;
    }
  })();

  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const homeMatchers: RegExp[] = [];
  if (home && home.length > 1) {
    homeMatchers.push(new RegExp(escapeRegex(home), "g"));
  }

  const usernameMatchers: RegExp[] = [];
  if (username && username.length > 1) {
    const escapedUsername = escapeRegex(username);
    // Replace username only when it appears inside a path-shaped
    // context (after `/`, `\\`, or `/Users/`). Bare-word username can
    // false-positive on real content; we leave that to the reviewer.
    usernameMatchers.push(new RegExp(`/Users/${escapedUsername}\\b`, "g"));
    usernameMatchers.push(new RegExp(`/home/${escapedUsername}\\b`, "g"));
    usernameMatchers.push(
      new RegExp(`\\\\Users\\\\${escapedUsername}\\b`, "g"),
    );
  }

  const credentialPatterns: Array<[RegExp, string]> = [
    [/sk-[A-Za-z0-9_-]{20,}/g, "<redacted-token>"],
    [/sk-ant-[A-Za-z0-9_-]{20,}/g, "<redacted-token>"],
    [/xoxb-[A-Za-z0-9-]{20,}/g, "<redacted-token>"],
    [/xoxp-[A-Za-z0-9-]{20,}/g, "<redacted-token>"],
    [/ghp_[A-Za-z0-9]{20,}/g, "<redacted-token>"],
    [/gho_[A-Za-z0-9]{20,}/g, "<redacted-token>"],
    [/github_pat_[A-Za-z0-9_]{20,}/g, "<redacted-token>"],
    [/AKIA[0-9A-Z]{16}/g, "<redacted-token>"],
    [/AIza[0-9A-Za-z_-]{30,}/g, "<redacted-token>"],
    [
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      "<redacted-jwt>",
    ],
    [
      /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
      "<redacted-private-key>",
    ],
    [/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer <redacted-token>"],
  ];

  return (input: string): string => {
    let result = input;
    for (const matcher of homeMatchers) {
      result = result.replace(matcher, "~");
    }
    for (const matcher of usernameMatchers) {
      result = result.replace(matcher, (full) =>
        full.replace(username ?? "", "<user>"),
      );
    }
    for (const [pattern, replacement] of credentialPatterns) {
      result = result.replace(pattern, replacement);
    }
    return result;
  };
};

export const collectStoreReleaseCommits = async (args: {
  repoRoot: string;
  attachedFeatureNames: string[];
  snapshot: ReturnType<StoreModStore["readFeatureSnapshot"]>;
}): Promise<StoreReleaseCommit[]> => {
  if (args.attachedFeatureNames.length === 0) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of args.attachedFeatureNames) {
    const item = args.snapshot?.items.find((entry) => entry.name === name);
    for (const rawHash of item?.commitHashes ?? []) {
      const hash = rawHash.trim();
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      ordered.push(hash);
    }
  }
  if (ordered.length === 0) return [];
  const redact = buildStoreReleaseRedactor();
  const commits: StoreReleaseCommit[] = [];
  for (const hash of ordered) {
    const { subject, diff } = await runStoreReleaseGitShow(args.repoRoot, hash);
    commits.push({
      hash,
      subject: redact(subject),
      diff: redact(diff),
    });
  }
  return commits;
};

export const buildStoreThreadAgentPrompt = (args: {
  userText: string;
  editingBlueprint: boolean;
  latestBlueprintMarkdown?: string;
  attachedFeatureNames: string[];
  transcript: Array<{
    role: "user" | "assistant" | "system_event";
    text: string;
    isBlueprint?: boolean;
    denied?: boolean;
    published?: boolean;
    attachedFeatureNames?: string[];
    editingBlueprint?: boolean;
  }>;
}) => {
  // Drop the just-sent user turn and the pending assistant placeholder
  // from the projected transcript. The worker appends both before this
  // builder runs; without trimming, `## Stated mod purpose` would
  // duplicate the user's latest message and the placeholder "Working…"
  // line would leak into the model's view of past turns.
  const priorTranscript = args.transcript.slice(0, -2);
  const recentTranscript = priorTranscript
    .map((message) => {
      const role = message.role === "system_event" ? "system" : message.role;
      const text = message.isBlueprint
        ? `[Blueprint draft saved: ${message.text.length} chars${
            message.denied ? ", denied" : message.published ? ", published" : ""
          }]`
        : message.text;
      const chips =
        message.attachedFeatureNames && message.attachedFeatureNames.length > 0
          ? `\nAttached changes: ${message.attachedFeatureNames.join(", ")}`
          : "";
      return `${role}: ${text}${chips}`;
    })
    .join("\n\n");

  const sections: Array<string | false> = [
    "## Stated purpose",
    args.userText,
    "",
    args.attachedFeatureNames.length > 0
      ? `## Attached features\n${args.attachedFeatureNames.map((n) => `- ${n}`).join("\n")}`
      : "## Attached features\n- none",
    "",
    "## How to scope your work",
    "The user is non-technical. They picked one or more named features above (or wrote a prompt) to describe what they want to publish. Treat each name as a scope hint pointing at a feature that already exists on this tree. Use `Read` and `Grep` to find the surfaces — components, modules, prompts, tools, schemas, configs — that implement each named feature, and ground your spec in what you actually find. If you cannot locate a feature from its name, ask one concise question rather than inventing surfaces.",
    "",
    "## Divergence model",
    "The installer's tree starts at the same root commit as this tree but may have diverged anywhere — partial refactors, alternate implementations of the same feature, missing files, renamed surfaces. Write the spec so an install agent reading it on a divergent tree can still produce the same observable behaviour. Functional parity, not byte parity. The publish pipeline ships per-commit reference diffs alongside your spec; you do not produce them, you do not reference them in the spec body, and you do not list `Files touched` / `Implementation` sections — that is the install agent's job.",
    "",
    args.editingBlueprint
      ? "## Mode\nEditing the existing draft. Revise it in place, preserve the `# Title` line unless the user asks to rename, and keep the section skeleton from the system prompt."
      : "## Mode\nDrafting a new behaviour spec.",
  ];

  if (args.latestBlueprintMarkdown) {
    sections.push("", "## Current draft", args.latestBlueprintMarkdown);
  }

  if (recentTranscript) {
    sections.push("", "## Recent store thread", recentTranscript);
  }

  return sections.filter((section) => section !== false).join("\n");
};

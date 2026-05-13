import fs from "node:fs/promises";
import path from "node:path";

import { agentHasCapability } from "../../../contracts/agent-runtime.js";
import type { RuntimePromptMessage } from "../../../protocol/index.js";
import type { ExtensionServices } from "../../../kernel/extensions/services.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";

/**
 * Chronicle injection (stella-runtime).
 *
 * Surfaces the latest chronicle window summaries —
 * `state/memories_extensions/chronicle/10m-current.md` and `6h-current.md`
 * — to the orchestrator on the next user message after the chronicle
 * summarizer has rewritten one of them.
 *
 * Why mtime, not turn count: chronicle is intentionally short-horizon
 * (10-minute / 6-hour rolling summaries refreshed by a background
 * sidecar). The interesting signal is "did the file change since we
 * last showed it?" — which decouples freshness from how chatty the user
 * is. An idle user who comes back after 30 minutes gets the fresh
 * summary on their next message even though no turns elapsed; a chatty
 * user firing several messages back-to-back doesn't get the same
 * summary re-injected on every turn because mtime hasn't moved.
 *
 * Why `before_user_message`: the hook only fires when the user actually
 * sends a message, so we never pay the cost on synthetic wake-ups, and
 * a long idle period naturally surfaces the *current* summary on
 * return (not a backlog of every window that passed during the gap).
 *
 * Cache safety: the injection lands in `appendMessages`, so it tails
 * the existing prompt-cache prefix. Persisted as
 * `customType: "bootstrap.chronicle_snapshot"` so `buildHistorySource`
 * carries it forward on subsequent turns just like the dynamic memory
 * bundle.
 */

const CHRONICLE_DIR_SEGMENTS = [
  "state",
  "memories_extensions",
  "chronicle",
] as const;
const TEN_MIN_FILE = "10m-current.md";
const SIX_HOUR_FILE = "6h-current.md";

type ChronicleWindow = {
  fileName: string;
  displayLabel: string;
  watermarkKey: "tenMinMtimeMs" | "sixHourMtimeMs";
};

const WINDOWS: ChronicleWindow[] = [
  {
    fileName: TEN_MIN_FILE,
    displayLabel: "last ~10 minutes",
    watermarkKey: "tenMinMtimeMs",
  },
  {
    fileName: SIX_HOUR_FILE,
    displayLabel: "last ~6 hours",
    watermarkKey: "sixHourMtimeMs",
  },
];

const createInternalPromptMessage = (text: string): RuntimePromptMessage => ({
  text,
  uiVisibility: "hidden",
  messageType: "message",
  customType: "bootstrap.chronicle_snapshot",
});

const buildChronicleBlock = (args: {
  displayLabel: string;
  displayPath: string;
  body: string;
}): string =>
  [
    `<chronicle_snapshot window="${args.displayLabel}" path="${args.displayPath}">`,
    args.body,
    "</chronicle_snapshot>",
  ].join("\n");

/**
 * Read a chronicle file via an open fd so the returned bytes and the
 * mtime that gates the watermark always describe the same inode.
 *
 * Chronicle writes atomically via `rename` (see `chronicle-summarizer.ts`
 * `writeFileAtomic`), so a path-level `stat` + `readFile` pair can
 * straddle an inode swap: the stat captures the OLD mtime, the read
 * returns the NEW bytes, and the watermark stored against OLD mtime
 * lets the same NEW bytes re-inject on the next turn. Holding an open
 * fd pins the inode for the duration of stat+read.
 */
const readChronicleAtomically = async (
  filePath: string,
): Promise<{ mtimeMs: number; body: string } | null> => {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const body = (await handle.readFile({ encoding: "utf8" })).trim();
    if (!body) return null;
    return { mtimeMs: stat.mtimeMs, body };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

export const createChronicleInjectionHook = (
  services: Pick<ExtensionServices, "stellaHome" | "stellaRoot" | "store">,
): HookDefinition<"before_user_message"> => ({
  event: "before_user_message",
  async handler(payload) {
    if (payload.isUserTurn !== true) return;
    if (!payload.conversationId) return;
    if (!agentHasCapability(payload.agentType, "injectsDynamicMemory")) {
      return;
    }

    const home =
      services.stellaHome?.trim() || services.stellaRoot?.trim() || "";
    if (!home) return;

    const chronicleDir = path.join(home, ...CHRONICLE_DIR_SEGMENTS);

    let watermark: ReturnType<
      ExtensionServices["store"]["getChronicleInjectionWatermark"]
    >;
    try {
      watermark = services.store.getChronicleInjectionWatermark(
        payload.conversationId,
      );
    } catch {
      // Watermark read failure must not block the user's turn or spam
      // injections every turn. Treat as "no information" and skip.
      return;
    }

    const appendMessages: RuntimePromptMessage[] = [];
    const updates: { tenMinMtimeMs?: number; sixHourMtimeMs?: number } = {};

    for (const window of WINDOWS) {
      const filePath = path.join(chronicleDir, window.fileName);
      const snapshot = await readChronicleAtomically(filePath);
      if (!snapshot) continue;
      const lastInjectedAt = watermark[window.watermarkKey];
      if (snapshot.mtimeMs <= lastInjectedAt) continue;

      // POSIX separators for LLM-facing display path regardless of host
      // platform — matches the convention used in `memory-injection.hook.ts`.
      const displayPath = path.posix.join(
        ...CHRONICLE_DIR_SEGMENTS,
        window.fileName,
      );
      appendMessages.push(
        createInternalPromptMessage(
          buildChronicleBlock({
            displayLabel: window.displayLabel,
            displayPath,
            body: snapshot.body,
          }),
        ),
      );
      updates[window.watermarkKey] = snapshot.mtimeMs;
    }

    if (appendMessages.length === 0) return;

    try {
      services.store.updateChronicleInjectionWatermark(
        payload.conversationId,
        updates,
      );
    } catch {
      // Watermark write failure means the same snapshot may inject again
      // next turn — preferable to dropping the injection that already
      // fired this turn.
    }

    return { appendMessages };
  },
});

import path from "node:path";
import { agentHasCapability } from "../../../contracts/agent-runtime.js";
import type { RuntimePromptMessage } from "../../../protocol/index.js";
import type { ExtensionServices } from "../../../kernel/extensions/services.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import { readOptionalTextFile } from "../../../kernel/shared/read-optional-text-file.js";

export const MEMORY_INJECTION_TURN_THRESHOLD = 40;
const DREAM_MEMORY_DISPLAY_PATH = "state/memories/MEMORY.md";
const DREAM_MEMORY_SUMMARY_DISPLAY_PATH = "state/memories/memory_summary.md";

const createInternalPromptMessage = (
  text: string,
  customType: string,
): RuntimePromptMessage => ({
  text,
  uiVisibility: "hidden",
  messageType: "message",
  customType,
});

const buildMemoryFileMessage = (
  displayPath: string,
  content: string,
): string =>
  [`<memory_file path="${displayPath}">`, content, "</memory_file>"].join("\n");

const shouldInjectThisTurn = (args: {
  services: Pick<ExtensionServices, "store">;
  agentType: string;
  conversationId?: string;
  isUserTurn?: boolean;
}): boolean => {
  if (!args.conversationId) return false;
  if (args.isUserTurn !== true) return false;
  if (!agentHasCapability(args.agentType, "injectsDynamicMemory")) return false;

  let counter: number;
  try {
    counter = args.services.store.incrementUserTurnsSinceMemoryInjection(
      args.conversationId,
    );
  } catch {
    // Counter failures should never block the user turn or spam memory every turn.
    return false;
  }

  if (counter === 1 || counter > MEMORY_INJECTION_TURN_THRESHOLD) {
    if (counter > 1) {
      try {
        args.services.store.resetUserTurnsSinceMemoryInjection(args.conversationId);
      } catch {
        // Preserve the injection decision; a later turn can self-heal the counter.
      }
    }
    return true;
  }
  return false;
};

const buildMemoryInjectionMessages = async (
  services: Pick<ExtensionServices, "stellaHome" | "stellaRoot" | "memoryStore">,
): Promise<RuntimePromptMessage[]> => {
  const messages: RuntimePromptMessage[] = [];
  const home = services.stellaHome?.trim() || services.stellaRoot?.trim();

  if (home) {
    const summary = await readOptionalTextFile(
      path.join(home, "state", "memories", "memory_summary.md"),
    );
    if (summary) {
      messages.push(
        createInternalPromptMessage(
          buildMemoryFileMessage(DREAM_MEMORY_SUMMARY_DISPLAY_PATH, summary),
          "bootstrap.memory_file",
        ),
      );
    }

    const memory = await readOptionalTextFile(
      path.join(home, "state", "memories", "MEMORY.md"),
    );
    if (memory) {
      messages.push(
        createInternalPromptMessage(
          buildMemoryFileMessage(DREAM_MEMORY_DISPLAY_PATH, memory),
          "bootstrap.memory_file",
        ),
      );
    }
  }

  // Freeze a fresh snapshot for this run so new writes appear on the next
  // injection without changing this run's prefix mid-flight.
  services.memoryStore.loadSnapshot();
  const userBlock = services.memoryStore.formatForSystemPrompt("user")?.trim();
  if (userBlock) {
    messages.push(
      createInternalPromptMessage(
        `<memory_snapshot target="user">\n${userBlock}\n</memory_snapshot>`,
        "bootstrap.memory_snapshot",
      ),
    );
  }
  const memoryBlock = services.memoryStore
    .formatForSystemPrompt("memory")
    ?.trim();
  if (memoryBlock) {
    messages.push(
      createInternalPromptMessage(
        `<memory_snapshot target="memory">\n${memoryBlock}\n</memory_snapshot>`,
        "bootstrap.memory_snapshot",
      ),
    );
  }

  return messages;
};

export const createMemoryInjectionHook = (
  services: Pick<
    ExtensionServices,
    "stellaHome" | "stellaRoot" | "store" | "memoryStore"
  >,
): HookDefinition<"before_user_message"> => ({
  event: "before_user_message",
  async handler(payload) {
    if (
      !shouldInjectThisTurn({
        services,
        agentType: payload.agentType,
        conversationId: payload.conversationId,
        isUserTurn: payload.isUserTurn,
      })
    ) {
      return;
    }

    const appendMessages = await buildMemoryInjectionMessages(services);
    return appendMessages.length > 0 ? { appendMessages } : undefined;
  },
});

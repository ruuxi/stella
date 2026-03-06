import { z } from "zod";
import { createServiceRequest } from "./http/service-request";
import { WINDOW_TEMPLATES, type NeriWindowType, type SearchResult } from "@/app/neri/neri-types";

export type VoiceWindowSummary = Array<{ type: string; title: string }>;

const ROUTER_AGENT_TYPE = "mercury";
const ROUTER_MAX_OUTPUT_TOKENS = 5000;

const WINDOW_TYPE_VALUES = Object.keys(WINDOW_TEMPLATES) as NeriWindowType[];
const WINDOW_TYPE_ENUM = z.enum(WINDOW_TYPE_VALUES as [NeriWindowType, ...NeriWindowType[]]);

const VoiceActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open_dashboard"),
    spokenResult: z.string().optional(),
  }),
  z.object({
    action: z.literal("close_dashboard"),
    spokenResult: z.string().optional(),
  }),
  z.object({
    action: z.literal("search_web"),
    query: z.string().min(1),
    spokenResult: z.string().optional(),
  }),
  z.object({
    action: z.literal("manage_window"),
    operation: z.enum(["focus", "close", "list"]),
    windowType: WINDOW_TYPE_ENUM.optional(),
    spokenResult: z.string().optional(),
  }),
  z.object({
    action: z.literal("create_canvas"),
    title: z.string().min(1),
    html: z.string().min(1),
    spokenResult: z.string().optional(),
  }),
  z.object({
    action: z.literal("delegate_orchestrator"),
    message: z.string().min(1),
    spokenResult: z.string().optional(),
  }),
  z.object({
    action: z.literal("no_action"),
    spokenResult: z.string().optional(),
  }),
]);

type VoiceAction = z.infer<typeof VoiceActionSchema>;

const WINDOW_ALIASES: Record<NeriWindowType, string[]> = {
  "news-feed": ["news", "news feed", "feed"],
  "music-player": ["music", "music player", "player"],
  "ai-search": ["ai search", "assistant search"],
  "calendar": ["calendar"],
  "game": ["game"],
  "system-monitor": ["system monitor", "system", "monitor"],
  "weather": ["weather"],
  "notes": ["notes", "note"],
  "file-browser": ["files", "file browser", "documents"],
  "search": ["search", "search results"],
  "canvas": ["canvas", "panel"],
};

const SEARCH_PREFIX_PATTERNS = [
  /\bgoogle\s+(?<query>.+)$/i,
  /\blook up\s+(?<query>.+)$/i,
  /\bsearch the web for\s+(?<query>.+)$/i,
  /\bsearch online for\s+(?<query>.+)$/i,
  /\bweb search\s+(?<query>.+)$/i,
];

const LOCAL_VOICE_ROUTER_PROMPT = `You are Stella's local voice action router.

Classify the user's request into exactly one action for the local voice runtime.
Return JSON only. Do not use markdown. Do not explain your reasoning.

Available actions:
- open_dashboard
- close_dashboard
- search_web
- manage_window
- create_canvas
- delegate_orchestrator
- no_action

Window types:
${WINDOW_TYPE_VALUES.map((value) => `- ${value}`).join("\n")}

Action rules:
- open_dashboard: show the dashboard or overlay.
- close_dashboard: hide the dashboard or overlay.
- search_web: use for current information or explicit web lookups. Include query.
- manage_window: focus, close, or list currently open dashboard windows. Include operation and windowType when relevant.
- create_canvas: use for visual panels like charts, comparisons, scoreboards, timers, or rich displays. Return complete standalone HTML with inline CSS and inline JS only when necessary.
- delegate_orchestrator: use for everything that needs files, shell, browser control, apps, reminders, memory, coding, or any deeper task execution.
- no_action: only when no action should happen because the request is effectively conversational or empty.

Output shape:
{
  "action": "open_dashboard" | "close_dashboard" | "search_web" | "manage_window" | "create_canvas" | "delegate_orchestrator" | "no_action",
  "spokenResult": "short natural sentence to say after the action completes",
  "query": "required for search_web",
  "operation": "focus" | "close" | "list",
  "windowType": "required when manage_window needs a target",
  "title": "required for create_canvas",
  "html": "required for create_canvas",
  "message": "required for delegate_orchestrator"
}

Additional rules:
- Prefer the local action types over delegate_orchestrator whenever the request can be completed entirely in the dashboard UI.
- For create_canvas, produce polished HTML with a light look that still fits the dashboard. Keep it self-contained.
- Keep spokenResult short, natural, and user-facing.
- If the request is ambiguous, use delegate_orchestrator with the original intent rather than inventing UI work.`;

const FALLBACK_ORCHESTRATOR_ERROR =
  "I hit a snag routing that locally, so I'm passing it to my main runtime.";

const stripJsonFences = (value: string): string =>
  value.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();

const normalizeForMatch = (value: string): string =>
  value.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

const friendlyWindowName = (windowType: NeriWindowType): string =>
  WINDOW_TEMPLATES[windowType]?.title ?? windowType;

const findWindowTypeFromText = (normalizedText: string): NeriWindowType | null => {
  for (const windowType of WINDOW_TYPE_VALUES) {
    const aliases = WINDOW_ALIASES[windowType] ?? [];
    if (aliases.some((alias) => normalizedText.includes(alias))) {
      return windowType;
    }
  }
  return null;
};

const truncateSpokenResult = (value: string, max = 260): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

const summarizeWindowList = (windowState: VoiceWindowSummary): string => {
  if (windowState.length === 0) {
    return "I don't have any dashboard windows open right now.";
  }

  const titles = windowState.map((entry) => entry.title.trim() || entry.type);
  if (titles.length === 1) {
    return `You have ${titles[0]} open right now.`;
  }
  if (titles.length === 2) {
    return `You currently have ${titles[0]} and ${titles[1]} open.`;
  }
  return `You currently have ${titles.slice(0, -1).join(", ")}, and ${titles[titles.length - 1]} open.`;
};

const buildRouterUserMessage = (message: string, windowState: VoiceWindowSummary): string => {
  const windowsText =
    windowState.length > 0
      ? windowState.map((entry) => `- ${entry.title} (${entry.type})`).join("\n")
      : "- none";

  return `User request:
${message.trim() || "(empty)"}

Currently visible dashboard windows:
${windowsText}`;
};

const buildFallbackAction = (message: string, spokenResult?: string): VoiceAction => ({
  action: "delegate_orchestrator",
  message: message.trim() || "Help the user with their most recent voice request.",
  ...(spokenResult ? { spokenResult } : {}),
});

export const detectVoiceReflexAction = (message: string): VoiceAction | null => {
  const normalized = normalizeForMatch(message);
  if (!normalized) {
    return { action: "no_action" };
  }

  if (/\b(open|show|pull up|bring up|launch)\b.*\b(dashboard|overlay|neri)\b/.test(normalized)) {
    return {
      action: "open_dashboard",
      spokenResult: "Your dashboard is open.",
    };
  }

  if (/\b(close|hide|dismiss)\b.*\b(dashboard|overlay|neri)\b/.test(normalized)) {
    return {
      action: "close_dashboard",
      spokenResult: "Okay, I hid the dashboard.",
    };
  }

  if (
    /\b(what windows are open|what s open|what is open|list windows|list open windows)\b/.test(normalized)
  ) {
    return {
      action: "manage_window",
      operation: "list",
    };
  }

  const mentionedWindowType = findWindowTypeFromText(normalized);
  if (mentionedWindowType && /\b(close|hide|dismiss|remove)\b/.test(normalized)) {
    return {
      action: "manage_window",
      operation: "close",
      windowType: mentionedWindowType,
      spokenResult: `Okay, I closed ${friendlyWindowName(mentionedWindowType)}.`,
    };
  }

  if (
    mentionedWindowType &&
    /\b(focus|switch to|go to|show me|bring up|pull up)\b/.test(normalized)
  ) {
    return {
      action: "manage_window",
      operation: "focus",
      windowType: mentionedWindowType,
      spokenResult: `Okay, I focused ${friendlyWindowName(mentionedWindowType)}.`,
    };
  }

  for (const pattern of SEARCH_PREFIX_PATTERNS) {
    const match = normalized.match(pattern);
    const query = match?.groups?.query?.trim();
    if (query) {
      return {
        action: "search_web",
        query,
        spokenResult: "I found a few results and put them on your dashboard.",
      };
    }
  }

  return null;
};

async function routeWithModel(message: string, windowState: VoiceWindowSummary): Promise<VoiceAction> {
  const { endpoint, headers } = await createServiceRequest("/api/ai/proxy", {
    "Content-Type": "application/json",
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentType: ROUTER_AGENT_TYPE,
      system: LOCAL_VOICE_ROUTER_PROMPT,
      messages: [{ role: "user", content: buildRouterUserMessage(message, windowState) }],
      maxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
      stream: false,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Voice action router ${response.status}: ${detail}`);
  }

  const body = (await response.json()) as { text?: string };
  const rawText = body.text?.trim();
  if (!rawText) {
    throw new Error("Voice action router returned no text.");
  }

  return VoiceActionSchema.parse(JSON.parse(stripJsonFences(rawText)));
}

export const toSearchResults = (payload: unknown): SearchResult[] => {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const rawResults = Array.isArray((payload as { results?: unknown[] }).results)
    ? (payload as { results: unknown[] }).results
    : [];

  return rawResults
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const title = typeof (entry as { title?: unknown }).title === "string"
        ? (entry as { title: string }).title.trim()
        : "";
      const url = typeof (entry as { url?: unknown }).url === "string"
        ? (entry as { url: string }).url.trim()
        : "";
      const snippetSource =
        typeof (entry as { snippet?: unknown }).snippet === "string"
          ? (entry as { snippet: string }).snippet
          : typeof (entry as { content?: unknown }).content === "string"
            ? (entry as { content: string }).content
            : typeof (entry as { text?: unknown }).text === "string"
              ? (entry as { text: string }).text
              : "";
      if (!title || !url) {
        return null;
      }
      return {
        title,
        url,
        snippet: snippetSource.trim().slice(0, 300),
      };
    })
    .filter((entry): entry is SearchResult => Boolean(entry));
};

const extractSearchAnswer = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const answer = (payload as { answer?: unknown }).answer;
  if (typeof answer !== "string") {
    return null;
  }
  const trimmed = answer.trim();
  return trimmed ? truncateSpokenResult(trimmed) : null;
};

const getOpenWindowTypes = async (): Promise<Set<NeriWindowType>> => {
  const { getNeriStore } = await import("@/app/neri/neri-store");
  const state = getNeriStore().getState();
  const workspace = state.workspaces[state.activeWorkspaceIndex];
  return new Set(
    workspace.columns.flatMap((column) =>
      column.windows.map((window) => window.type),
    ),
  );
};

const executeManageWindowAction = async (
  action: Extract<VoiceAction, { action: "manage_window" }>,
  windowState: VoiceWindowSummary,
): Promise<string> => {
  if (action.operation === "list") {
    return action.spokenResult ?? summarizeWindowList(windowState);
  }

  if (!action.windowType) {
    return "Tell me which window you want me to change.";
  }

  const openWindowTypes = await getOpenWindowTypes();
  if (!openWindowTypes.has(action.windowType)) {
    return `I couldn't find ${friendlyWindowName(action.windowType)} in the current dashboard.`;
  }

  const { getNeriStore } = await import("@/app/neri/neri-store");
  const store = getNeriStore();
  window.electronAPI?.overlay.showNeri?.();

  if (action.operation === "focus") {
    store.dispatch({ type: "focus-window-by-type", windowType: action.windowType });
    return action.spokenResult ?? `Okay, I focused ${friendlyWindowName(action.windowType)}.`;
  }

  store.dispatch({ type: "close-window-by-type", windowType: action.windowType });
  return action.spokenResult ?? `Okay, I closed ${friendlyWindowName(action.windowType)}.`;
};

const executeSearchAction = async (
  action: Extract<VoiceAction, { action: "search_web" }>,
): Promise<string> => {
  const { endpoint, headers } = await createServiceRequest("/api/ai/search", {
    "Content-Type": "application/json",
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: action.query,
      maxResults: 6,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Search ${response.status}: ${detail}`);
  }

  const payload = await response.json();
  const results = toSearchResults(payload);
  const answer = extractSearchAnswer(payload);

  const { getNeriStore } = await import("@/app/neri/neri-store");
  window.electronAPI?.overlay.showNeri?.();
  getNeriStore().dispatch({
    type: "open-search-window",
    query: action.query,
    results,
  });

  if (answer) {
    return answer;
  }
  if (results.length > 0) {
    return action.spokenResult ?? "I found a few results and put them on your dashboard.";
  }
  return "I didn't find any strong results for that, but I opened a search window for you.";
};

const executeCanvasAction = async (
  action: Extract<VoiceAction, { action: "create_canvas" }>,
): Promise<string> => {
  const { getNeriStore } = await import("@/app/neri/neri-store");
  window.electronAPI?.overlay.showNeri?.();
  getNeriStore().dispatch({
    type: "open-canvas-window",
    title: action.title,
    html: action.html,
  });
  return action.spokenResult ?? `I put ${action.title} on your dashboard.`;
};

const executeDelegatedAction = async (
  action: Extract<VoiceAction, { action: "delegate_orchestrator" }>,
  conversationId: string | undefined,
): Promise<string> => {
  if (!conversationId) {
    throw new Error("Missing conversation ID for orchestrator handoff.");
  }
  const api = window.electronAPI?.voice;
  if (!api?.orchestratorChat) {
    throw new Error("Local orchestrator handoff is unavailable.");
  }

  const reply = await api.orchestratorChat({
    conversationId,
    message: action.message,
  });
  return reply.trim() || action.spokenResult || "Done.";
};

async function executeVoiceAction(
  action: VoiceAction,
  args: {
    conversationId?: string;
    windowState: VoiceWindowSummary;
  },
): Promise<string> {
  switch (action.action) {
    case "open_dashboard":
      window.electronAPI?.overlay.showNeri?.();
      return action.spokenResult ?? "Your dashboard is open.";
    case "close_dashboard":
      window.electronAPI?.overlay.hideNeri?.();
      return action.spokenResult ?? "Okay, I hid the dashboard.";
    case "search_web":
      return await executeSearchAction(action);
    case "manage_window":
      return await executeManageWindowAction(action, args.windowState);
    case "create_canvas":
      return await executeCanvasAction(action);
    case "delegate_orchestrator":
      return await executeDelegatedAction(action, args.conversationId);
    case "no_action":
      return action.spokenResult ?? "";
  }
}

export async function runLocalVoiceAction(args: {
  message: string;
  conversationId?: string;
  windowState?: VoiceWindowSummary;
}): Promise<{ action: string; spokenResult: string }> {
  const message = args.message.trim();
  const windowState = args.windowState ?? [];

  let action = detectVoiceReflexAction(message);
  if (!action) {
    try {
      action = await routeWithModel(message, windowState);
    } catch (error) {
      console.error("[voice-action-router] Model routing failed:", error);
      action = buildFallbackAction(message, FALLBACK_ORCHESTRATOR_ERROR);
    }
  }

  try {
    const spokenResult = await executeVoiceAction(action, {
      conversationId: args.conversationId,
      windowState,
    });
    return { action: action.action, spokenResult };
  } catch (error) {
    if (action.action !== "delegate_orchestrator") {
      try {
        const fallbackAction = buildFallbackAction(message, FALLBACK_ORCHESTRATOR_ERROR);
        const spokenResult = await executeVoiceAction(fallbackAction, {
          conversationId: args.conversationId,
          windowState,
        });
        return { action: fallbackAction.action, spokenResult };
      } catch (fallbackError) {
        console.error("[voice-action-router] Fallback handoff failed:", fallbackError);
      }
    }
    throw error;
  }
}

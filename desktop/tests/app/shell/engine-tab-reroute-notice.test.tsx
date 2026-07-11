// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A saved Codex model that is gone from BOTH the live model/list and the
// static registry, so selecting ChatGPT reroutes to gpt-5.6-sol and surfaces
// the notice. gpt-5.6-sol is the only model both catalogs know about.
const prefs = {
  defaultModels: {},
  modelOverrides: {},
  assistantPropagatedAgents: [],
  reasoningEfforts: {},
  stellaConversationModelOverrides: {},
  stellaConversationReasoningEfforts: {},
  agentRuntimeEngine: "default" as const,
  codexModel: "gpt-legacy-gone",
  codexModelExplicit: false,
  codexReasoningEffort: "default" as const,
  claudeCodeModel: "default",
  claudeCodeReasoningEffort: "default" as const,
  maxAgentConcurrency: 24,
  imageGeneration: { provider: "stella" as const },
  realtimeVoice: { provider: "stella" as const },
};

vi.mock("@/global/settings/hooks/use-model-catalog", () => ({
  useModelCatalog: () => ({
    models: [],
    allModels: [
      {
        id: "openai-codex/gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        provider: "openai-codex",
        providerName: "openai-codex",
        modelId: "gpt-5.6-sol",
        source: "local",
      },
    ],
    defaults: [],
    groups: [],
    refresh: vi.fn(),
    refreshing: false,
    audience: null,
  }),
}));

vi.mock("@/global/settings/hooks/use-codex-model-catalog", () => ({
  useCodexModelCatalog: () => ({
    models: [{ id: "gpt-5.6-sol", hidden: false }],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/global/settings/hooks/use-llm-credentials", () => ({
  useLlmCredentials: () => ({
    validateOAuth: vi.fn(async () => ({ connected: true })),
    loginOAuth: vi.fn(async () => {}),
    cancelOAuth: vi.fn(async () => {}),
    loading: false,
  }),
}));

vi.mock("@/global/settings/EnginePickerPill", () => ({
  EnginePickerPill: ({ onChange }: { onChange: (engine: string) => void }) => (
    <button
      type="button"
      data-testid="pick-chatgpt"
      onClick={() => onChange("codex_cli")}
    >
      ChatGPT
    </button>
  ),
}));

vi.mock("@/shell/display/EngineRuntimeModelPanel", () => ({
  EngineRuntimeModelPanel: () => null,
}));
vi.mock("@/global/settings/ProviderModelPanel", () => ({
  ProviderModelPanel: () => null,
}));
vi.mock("@/global/settings/ProviderOnlyPicker", () => ({
  ProviderOnlyPicker: () => null,
}));
vi.mock("@/global/settings/VoiceProviderPicker", () => ({
  VoiceProviderPicker: () => null,
}));
vi.mock("@/global/billing/audience", () => ({
  getPlanLabel: () => "",
  isRestrictedModelOverrideAudience: () => false,
}));
vi.mock("@/ui/icons", () => ({
  MoreHorizontal: () => null,
  RefreshCw: () => null,
  RotateCcw: () => null,
}));
vi.mock("@/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: unknown }) => children ?? null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children?: unknown }) =>
    children ?? null,
}));

import { EngineTabContent } from "@/shell/display/EngineTabContent";

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("EngineTabContent reroute notice", () => {
  let container: HTMLDivElement;
  let root: Root;
  let setSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    setSpy = vi.fn(async (patch: Record<string, unknown>) => ({
      ...prefs,
      ...patch,
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      system: {
        getLocalModelPreferences: vi.fn(async () => ({ ...prefs })),
        setLocalModelPreferences: setSpy,
        listCodexModels: vi.fn(async () => ({
          models: [{ id: "gpt-5.6-sol", hidden: false }],
        })),
        listClaudeCodeModels: vi.fn(async () => ({ models: [] })),
      },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows the routed notice in the status slot after a reroute save", async () => {
    await act(async () => {
      root.render(<EngineTabContent />);
    });
    // Let the initial preferences load settle.
    await flush();

    const pill = container.querySelector(
      '[data-testid="pick-chatgpt"]',
    ) as HTMLButtonElement | null;
    expect(pill).not.toBeNull();

    await act(async () => {
      pill?.click();
    });
    // saveEngine → validateOAuth → writePreferences → showNotice all resolve.
    await flush();

    // The reroute rewrote codexModel to the available model...
    expect(setSpy).toHaveBeenCalled();
    const rerouted = setSpy.mock.calls.some(
      ([patch]) =>
        (patch as { codexModel?: string })?.codexModel === "gpt-5.6-sol",
    );
    expect(rerouted).toBe(true);

    // ...and the deferred notice survived writePreferences' clearStatus().
    const status = container.querySelector(".engine-tab__status-slot");
    expect(status?.textContent ?? "").toContain(
      "Routed to gpt-5.6-sol (saved model unavailable).",
    );
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/global/settings/hooks/use-model-catalog", () => ({
  useModelCatalog: () => ({
    models: [],
    allModels: [],
    defaults: [],
    groups: [],
    refresh: vi.fn(async () => {}),
    refreshing: false,
    audience: null,
    error: null,
  }),
}));

vi.mock("@/global/settings/hooks/use-codex-model-catalog", () => ({
  useCodexModelCatalog: () => ({
    models: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/global/settings/hooks/use-llm-credentials", () => ({
  useLlmCredentials: () => ({
    apiKeys: [],
    oauthCredentials: [],
    oauthProviders: [],
    validateOAuth: vi.fn(async () => ({
      connected: true,
      needsReauth: false,
    })),
    loginOAuth: vi.fn(async () => {}),
    cancelOAuth: vi.fn(async () => {}),
    saveApiKey: vi.fn(async () => {}),
    removeApiKey: vi.fn(async () => {}),
    logoutOAuth: vi.fn(async () => {}),
    loading: false,
  }),
}));

vi.mock("@/global/settings/EnginePickerPill", () => ({
  EnginePickerPill: () => null,
}));
vi.mock("@/shell/display/EngineRuntimeModelPanel", () => ({
  EngineRuntimeModelPanel: () => null,
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
  Check: () => null,
  KeyRound: () => null,
  Lightbulb: () => null,
  LogIn: () => null,
  LogOut: () => null,
  MoreHorizontal: () => null,
  RefreshCw: () => null,
  RotateCcw: () => null,
  Search: () => null,
  Star: () => null,
}));
vi.mock("@/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: unknown }) => children ?? null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuRadioGroup: ({ children }: { children?: unknown }) =>
    children ?? null,
  DropdownMenuRadioItem: ({ children }: { children?: unknown }) =>
    children ?? null,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children?: unknown }) =>
    children ?? null,
}));

const legacyPreferences = {
  defaultModels: {},
  modelOverrides: {},
  assistantPropagatedAgents: [],
  reasoningEfforts: {},
  stellaConversationModelOverrides: {},
  stellaConversationReasoningEfforts: {},
  agentRuntimeEngine: "default" as const,
  codexModel: "gpt-5.6-sol",
  codexModelExplicit: false,
  codexReasoningEffort: "default" as const,
  codexServiceTier: "standard" as const,
  claudeCodeModel: "default",
  claudeCodeReasoningEffort: "default" as const,
  maxAgentConcurrency: 24,
  imageGeneration: { provider: "stella" as const },
  realtimeVoice: { provider: "stella" as const },
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("EngineTabContent subscription harness footer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("keeps the generic provider picker search by default", async () => {
    const { ProviderModelPanel } = await import(
      "@/global/settings/ProviderModelPanel"
    );
    await act(async () => {
      root.render(
        <ProviderModelPanel
          value=""
          defaultLabel="Default"
          currentLabel="Default"
          groups={[]}
          onSelect={() => {}}
        />,
      );
    });

    expect(
      container.querySelector('[aria-label="Search models"]'),
    ).not.toBeNull();
  });

  it("hides search in the Stella embed and persists an unchecked legacy default", async () => {
    const setPreferences = vi.fn(async (patch: Record<string, unknown>) => ({
      ...legacyPreferences,
      ...patch,
    }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      system: {
        getLocalModelPreferences: vi.fn(async () => ({
          ...legacyPreferences,
        })),
        setLocalModelPreferences: setPreferences,
        listCodexModels: vi.fn(async () => ({ models: [] })),
        listClaudeCodeModels: vi.fn(async () => ({ models: [] })),
      },
    };

    const { EngineTabContent } = await import(
      "@/shell/display/EngineTabContent"
    );
    await act(async () => {
      root.render(<EngineTabContent />);
    });
    await settle();

    expect(container.querySelector('[aria-label="Search models"]')).toBeNull();
    const checkbox = container.querySelector(
      '.engine-tab__subscription-option input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    expect(checkbox?.disabled).toBe(false);
    expect(container.textContent).toContain(
      "Use subscriptions through Stella harness",
    );

    await act(async () => {
      checkbox?.click();
    });
    await settle();

    expect(setPreferences).toHaveBeenCalledWith({
      subscriptionHarnessEnabled: true,
    });
    expect(checkbox?.checked).toBe(true);
  });
});

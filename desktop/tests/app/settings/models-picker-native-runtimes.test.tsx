// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setLocalModelPreferences } = vi.hoisted(() => ({
  setLocalModelPreferences: vi.fn(),
}));

vi.mock("@/shell/topbar/nav-surface-preloads", () => ({
  preloadModelsPicker: vi.fn(),
}));

vi.mock("@/global/settings/hooks/use-model-catalog", () => ({
  useModelCatalog: () => ({
    models: [],
    allModels: [
      {
        id: "stella/default",
        name: "Stella Default",
        provider: "stella",
      },
      {
        id: "google/gemini-3-flash-preview",
        name: "Gemini 3 Flash",
        provider: "google",
      },
    ],
    defaults: [],
    groups: [
      {
        provider: "stella",
        providerName: "Stella",
        models: [
          {
            id: "stella/default",
            name: "Stella Default",
            provider: "stella",
          },
        ],
        runtimeManaged: true,
        runtimeManagedAuth: false,
        runtimeCredentialless: true,
      },
      {
        provider: "google",
        providerName: "Google",
        models: [
          {
            id: "google/gemini-3-flash-preview",
            name: "Gemini 3 Flash",
            provider: "google",
          },
        ],
        runtimeManaged: false,
        runtimeManagedAuth: false,
        runtimeCredentialless: false,
      },
    ],
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

vi.mock("@/global/settings/hooks/use-claude-code-model-catalog", () => ({
  useClaudeCodeModelCatalog: () => ({
    models: [],
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock("@/global/settings/hooks/use-llm-credentials", () => ({
  findApiKey: () => undefined,
  findOauthCredential: () => undefined,
  findOauthProvider: () => undefined,
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

vi.mock("@/global/settings/ProviderOnlyPicker", () => ({
  ProviderOnlyPicker: () => null,
}));
vi.mock("@/global/settings/VoiceCatalogPicker", () => ({
  VoiceCatalogPicker: () => null,
}));
vi.mock("@/global/billing/audience", () => ({
  getPlanLabel: () => "",
  isRestrictedModelOverrideAudience: () => false,
}));
vi.mock("@/router", () => ({ router: { navigate: vi.fn() } }));
vi.mock("@/features/workspace-display/default-tabs", () => ({
  openEngineDisplayTab: vi.fn(),
}));
vi.mock("@/shared/hooks/use-edge-fade", () => ({
  useEdgeFadeRef: () => ({ current: null }),
}));
vi.mock("@/ui/toast", () => ({ showToast: vi.fn() }));

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
  useNativeAgentRuntimes: false,
  maxAgentConcurrency: 24,
  imageGeneration: { provider: "stella" as const },
  realtimeVoice: { provider: "stella" as const },
};

const waitForMountedPicker = async (): Promise<HTMLElement> => {
  let picker: HTMLElement | null = null;
  await vi.waitFor(
    () => {
      picker = document.body.querySelector('[data-models-picker="true"]');
      expect(picker?.querySelector(".agent-model-picker")).not.toBeNull();
    },
    { timeout: 5_000 },
  );
  return picker as HTMLElement;
};

describe("ModelsPicker native agent runtime control", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    let persistedPreferences = { ...legacyPreferences };
    setLocalModelPreferences.mockImplementation(
      async (patch: Record<string, unknown>) => {
        persistedPreferences = { ...persistedPreferences, ...patch };
        return persistedPreferences;
      },
    );
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      system: {
        getLocalModelPreferences: vi.fn(async () => persistedPreferences),
        setLocalModelPreferences,
      },
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body
      .querySelectorAll('[data-component="popover-content"]')
      .forEach((element) => element.remove());
    vi.clearAllMocks();
  });

  it("mounts the picker when the Home overlay opens it programmatically", async () => {
    const { ModelsPicker } = await import("@/global/settings/ModelsPicker");
    const trigger = <button type="button">Models</button>;
    await act(async () => {
      root.render(
        <ModelsPicker trigger={trigger} open={false} onOpenChange={() => {}} />,
      );
    });
    expect(
      document.body.querySelector(
        '[data-models-picker="true"] .agent-model-picker',
      ),
    ).toBeNull();

    await act(async () => {
      root.render(
        <ModelsPicker trigger={trigger} open onOpenChange={() => {}} />,
      );
    });

    const picker = await waitForMountedPicker();
    expect(picker.getAttribute("data-state")).toBe("open");
    expect(picker.textContent).toContain("Use native Codex and Claude Code");
    expect(picker.textContent).toContain(
      "Checked runs them directly using their native configuration, skills, and MCPs. Unchecked uses Stella's harness.",
    );
  });

  it("persists checked and unchecked native runtime behavior while keeping provider search scoped", async () => {
    const { ModelsPicker } = await import("@/global/settings/ModelsPicker");
    await act(async () => {
      root.render(
        <ModelsPicker trigger={<button type="button">Models</button>} />,
      );
    });

    const trigger = container.querySelector(
      '[data-slot="models-picker-trigger"]',
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());

    const picker = await waitForMountedPicker();
    expect(picker.querySelector('[aria-label="Search models"]')).toBeNull();

    const checkbox = picker.querySelector(
      '.agent-model-picker-footer input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox?.checked).toBe(false);
    expect(checkbox?.disabled).toBe(false);
    expect(picker?.textContent).toContain("Use native Codex and Claude Code");
    expect(picker?.textContent).toContain(
      "Checked runs them directly using their native configuration, skills, and MCPs. Unchecked uses Stella's harness.",
    );

    await act(async () => checkbox?.click());
    await vi.waitFor(() => {
      expect(setLocalModelPreferences).toHaveBeenCalledWith({
        useNativeAgentRuntimes: true,
      });
      expect(checkbox?.checked).toBe(true);
    });

    await act(async () => checkbox?.click());
    await vi.waitFor(() => {
      expect(setLocalModelPreferences).toHaveBeenLastCalledWith({
        useNativeAgentRuntimes: false,
      });
      expect(checkbox?.checked).toBe(false);
    });

    const googleTab = picker.querySelector(
      'button[role="tab"][aria-label="Google"]',
    ) as HTMLButtonElement | null;
    expect(googleTab).not.toBeNull();
    await act(async () => googleTab?.click());

    expect(picker.querySelector('[aria-label="Search models"]')).not.toBeNull();
  });
});

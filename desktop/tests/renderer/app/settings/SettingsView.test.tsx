import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { useQuery, useMutation } from "convex/react";
import SettingsDialog from "../../../../src/global/settings/SettingsView";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => undefined),
  useMutation: vi.fn(() => vi.fn()),
}));

const mockUseAuthSessionState = vi.fn(() => ({
  hasConnectedAccount: true,
}));

vi.mock("@/global/auth/hooks/use-auth-session-state", () => ({
  useAuthSessionState: () => mockUseAuthSessionState(),
}));

vi.mock("@/convex/api", () => ({
  api: {
    data: {
      preferences: {
        getModelDefaults: "preferences.getModelDefaults",
        getModelOverrides: "preferences.getModelOverrides",
        setModelOverride: "preferences.setModelOverride",
        clearModelOverride: "preferences.clearModelOverride",
        getGeneralAgentEngine: "preferences.getGeneralAgentEngine",
        setGeneralAgentEngine: "preferences.setGeneralAgentEngine",
        getCodexLocalMaxConcurrency: "preferences.getCodexLocalMaxConcurrency",
        setCodexLocalMaxConcurrency: "preferences.setCodexLocalMaxConcurrency",
      },
      secrets: {
        listSecrets: "secrets.listSecrets",
        createSecret: "secrets.createSecret",
        deleteSecret: "secrets.deleteSecret",
      },
    },
  },
}));

vi.mock("@/global/settings/hooks/use-model-catalog", () => ({
  useModelCatalog: vi.fn(() => ({
    models: [
      { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5", provider: "moonshotai" },
      {
        id: "anthropic/claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
      },
      { id: "anthropic/claude-3", name: "Claude 3", provider: "anthropic" },
      { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
      { id: "zai/glm-4.7", name: "GLM 4.7", provider: "zai" },
    ],
    groups: [
      {
        provider: "moonshotai",
        models: [{ id: "moonshotai/kimi-k2.5", name: "Kimi K2.5" }],
      },
      {
        provider: "anthropic",
        models: [
          { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
          { id: "anthropic/claude-3", name: "Claude 3" },
        ],
      },
      { provider: "openai", models: [{ id: "openai/gpt-4o", name: "GPT-4o" }] },
      { provider: "zai", models: [{ id: "zai/glm-4.7", name: "GLM 4.7" }] },
    ],
    loading: false,
  })),
}));

const mockListLlmCredentials = vi.fn();
const mockSaveLlmCredential = vi.fn();
const mockDeleteLlmCredential = vi.fn();

// Lightweight mock of the Radix-based Dialog components so that the dialog
// content is rendered synchronously in jsdom when `open` is true.
vi.mock("@/ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div data-testid="dialog-root">
        <button
          type="button"
          data-testid="dialog-close"
          onClick={() => onOpenChange(false)}
        >
          close
        </button>
        {children}
      </div>
    ) : null,
  DialogContent: ({
    children,
  }: {
    children: React.ReactNode;
    size?: string;
    className?: string;
  }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogCloseButton: () => <button type="button">X</button>,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultProps(
  overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {},
) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };
}

function mockUseQuery(impl: (queryPath: unknown, args?: unknown) => unknown) {
  vi.mocked(useQuery).mockImplementation(impl as never);
}

function mockUseMutation(impl: (mutationPath: unknown) => unknown) {
  vi.mocked(useMutation).mockImplementation(impl as never);
}

/**
 * Configure useQuery mock to return different values based on query key.
 */
function setupUseQuery(
  opts: {
    modelDefaults?: Array<{
      agentType: string;
      model: string;
      resolvedModel: string;
    }>;
    modelOverrides?: string;
    generalAgentEngine?: "default" | "codex_local" | "claude_code_local";
    codexLocalMaxConcurrency?: number;
  } = {},
) {
  mockUseQuery((queryPath: unknown) => {
    const path = queryPath as string;
    if (path === "preferences.getModelDefaults") {
      return Object.prototype.hasOwnProperty.call(opts, "modelDefaults")
        ? opts.modelDefaults
        : [
            {
              agentType: "orchestrator",
              model: "stella/default",
              resolvedModel: "moonshotai/kimi-k2.5",
            },
            {
              agentType: "general",
              model: "stella/default",
              resolvedModel: "moonshotai/kimi-k2.5",
            },
            {
              agentType: "browser",
              model: "stella/default",
              resolvedModel: "anthropic/claude-sonnet-4.6",
            },
            {
              agentType: "explore",
              model: "stella/default",
              resolvedModel: "zai/glm-4.7",
            },
          ];
    }
    if (path === "preferences.getModelOverrides") {
      return Object.prototype.hasOwnProperty.call(opts, "modelOverrides")
        ? opts.modelOverrides
        : JSON.stringify({});
    }
    if (path === "preferences.getGeneralAgentEngine") {
      return Object.prototype.hasOwnProperty.call(opts, "generalAgentEngine")
        ? opts.generalAgentEngine
        : "default";
    }
    if (path === "preferences.getCodexLocalMaxConcurrency") {
      return Object.prototype.hasOwnProperty.call(
        opts,
        "codexLocalMaxConcurrency",
      )
        ? opts.codexLocalMaxConcurrency
        : 3;
    }
    return undefined;
  });
}

function setupElectronApi(
  credentials: Array<{
    provider: string;
    label: string;
    status: "active";
    updatedAt?: number;
  }> = [],
) {
  mockListLlmCredentials.mockResolvedValue(
    credentials.map((entry, index) => ({
      provider: entry.provider,
      label: entry.label,
      status: entry.status,
      updatedAt: entry.updatedAt ?? index + 1,
    })),
  );
  mockSaveLlmCredential.mockImplementation(
    async (payload: {
      provider: string;
      label: string;
      plaintext: string;
    }) => ({
      provider: payload.provider,
      label: payload.label,
      status: "active" as const,
      updatedAt: Date.now(),
    }),
  );
  mockDeleteLlmCredential.mockResolvedValue({ removed: true });

  window.electronAPI = {
    system: {
      listLlmCredentials: mockListLlmCredentials,
      saveLlmCredential: mockSaveLlmCredential,
      deleteLlmCredential: mockDeleteLlmCredential,
    },
  } as unknown as typeof window.electronAPI;
}

async function openModelsTab() {
  await act(async () => {
    fireEvent.click(screen.getByText("Models"));
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(mockListLlmCredentials).toHaveBeenCalled();
    expect(screen.getByText("API Keys")).toBeTruthy();
  });
}

async function renderModelsTab() {
  render(<SettingsDialog {...defaultProps()} />);
  await openModelsTab();
}

const LLM_PROVIDER_ROW_COUNT = 12;

// ---------------------------------------------------------------------------
// Tests: Dialog rendering
// ---------------------------------------------------------------------------

describe("SettingsDialog rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthSessionState.mockReturnValue({ hasConnectedAccount: true });
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders nothing visible when open=false", () => {
    const { container } = render(
      <SettingsDialog {...defaultProps({ open: false })} />,
    );
    expect(screen.queryByText("Settings")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("shows settings dialog content when open=true", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("renders the dialog root element when open", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByTestId("dialog-root")).toBeTruthy();
  });

  it("calls onOpenChange(false) when close button is clicked", () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog {...defaultProps({ onOpenChange })} />);

    fireEvent.click(screen.getByTestId("dialog-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Tab switching
// ---------------------------------------------------------------------------

describe("Tab switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("shows Basic and Models tabs in sidebar", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Basic")).toBeTruthy();
    expect(screen.getByText("Models")).toBeTruthy();
  });

  it("shows Basic tab as active by default", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const basicTab = screen.getByText("Basic");
    expect(basicTab.className).toContain("settings-sidebar-tab--active");

    const modelsTab = screen.getByText("Models");
    expect(modelsTab.className).not.toContain("settings-sidebar-tab--active");
  });

  it("shows BasicTab content by default (Storage, Sign Out, etc)", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Storage")).toBeTruthy();
    // "Sign Out" appears as both label and button
    const signOutElements = screen.getAllByText("Sign Out");
    expect(signOutElements.length).toBeGreaterThanOrEqual(2);
  });

  it("switches to Models tab when clicked", async () => {
    render(<SettingsDialog {...defaultProps()} />);

    await openModelsTab();

    // Models tab should now be active
    expect(screen.getByText("Models").className).toContain(
      "settings-sidebar-tab--active",
    );
    expect(screen.getByText("Basic").className).not.toContain(
      "settings-sidebar-tab--active",
    );

    // Models tab content should appear
    expect(screen.getByText("Model Configuration")).toBeTruthy();
    expect(screen.getByText("API Keys")).toBeTruthy();

    // Basic tab content should be hidden
    expect(screen.queryByText("Storage")).toBeNull();
  });

  it("switches back to Basic tab from Models", async () => {
    render(<SettingsDialog {...defaultProps()} />);

    await openModelsTab();
    expect(screen.queryByText("Storage")).toBeNull();

    fireEvent.click(screen.getByText("Basic"));
    expect(screen.getByText("Storage")).toBeTruthy();
    expect(screen.queryByText("Model Configuration")).toBeNull();
  });
});

describe("Basic tab privacy copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("shows local-only storage wording", () => {
    render(<SettingsDialog {...defaultProps()} />);

    expect(screen.getByText("Storage")).toBeTruthy();
    expect(
      screen.getByText(/Local only\. Conversations stay on this device\./),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Cloud sync and connected mode are not available in the app right now\./,
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: BasicTab
// ---------------------------------------------------------------------------

describe("BasicTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders Sign Out row with Sign Out button", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Sign out of your account")).toBeTruthy();

    const signOutBtn = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent === "Sign Out");
    expect(signOutBtn).toBeTruthy();
  });

  it("calls onSignOut when Sign Out button is clicked", () => {
    const onSignOut = vi.fn();
    render(<SettingsDialog {...defaultProps({ onSignOut })} />);

    const signOutBtn = screen
      .getAllByRole("button")
      .find((btn) => btn.textContent === "Sign Out");
    fireEvent.click(signOutBtn!);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("renders Delete Data row as disabled until the feature is implemented", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Delete Data")).toBeTruthy();
    expect(
      screen.getByText("Erase all conversations and memories."),
    ).toBeTruthy();
    expect(
      screen.getAllByText(
        "This action is not available in the desktop app yet.",
      )[0],
    ).toBeTruthy();

    const deleteButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.textContent === "Delete");
    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
    expect(deleteButtons[0].className).toContain("settings-btn--danger");
    expect(deleteButtons[0]).toBeDisabled();
  });

  it("renders Delete Account row as disabled until the feature is implemented", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Delete Account")).toBeTruthy();
    expect(
      screen.getByText("Permanently remove your account and all data."),
    ).toBeTruthy();

    const deleteButtons = screen
      .getAllByRole("button")
      .filter((btn) => btn.textContent === "Delete");
    // There should be two Delete buttons: Delete Data and Delete Account
    expect(deleteButtons.length).toBe(2);
    expect(deleteButtons[1].className).toContain("settings-btn--danger");
    expect(deleteButtons[1]).toBeDisabled();
  });

  it("renders all five BasicTab rows", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const rows = document.querySelectorAll(".settings-row");
    expect(rows.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Tests: ModelConfigSection
// ---------------------------------------------------------------------------

describe("GeneralAgentRuntimeSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders General Agent Runtime section on Models tab", async () => {
    setupUseQuery();
    await renderModelsTab();

    expect(screen.getByText("General Agent Runtime")).toBeTruthy();
    expect(screen.getByText("Engine")).toBeTruthy();
  });

  it("hides Codex concurrency control when engine is default", async () => {
    setupUseQuery({ generalAgentEngine: "default" });
    await renderModelsTab();

    expect(screen.queryByText("Parallel Codex Sessions")).toBeNull();
  });

  it("shows Codex concurrency control when engine is codex_local", async () => {
    setupUseQuery({
      generalAgentEngine: "codex_local",
      codexLocalMaxConcurrency: 2,
    });
    await renderModelsTab();

    expect(screen.getByText("Parallel Codex Sessions")).toBeTruthy();
    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects.length).toBe(2);
    expect(selects[1].value).toBe("2");
  });

  it("waits for saved runtime preferences before rendering editable values", async () => {
    setupUseQuery({
      generalAgentEngine: undefined,
      codexLocalMaxConcurrency: undefined,
    });
    await renderModelsTab();

    const select = document.querySelector(
      ".settings-runtime-select",
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("loading");
    expect(select.options[0]?.textContent).toBe("Loading saved setting...");
    expect(screen.queryByText("Parallel Codex Sessions")).toBeNull();
  });

  it("calls setGeneralAgentEngine when engine is changed", async () => {
    const mockSetGeneralAgentEngine = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setGeneralAgentEngine")
        return mockSetGeneralAgentEngine;
      return vi.fn();
    });
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "codex_local" } });
      await Promise.resolve();
    });

    expect(mockSetGeneralAgentEngine).toHaveBeenCalledWith({
      engine: "codex_local",
    });
  });

  it("shows Claude Code option in General Agent Runtime engine select", async () => {
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects.length).toBeGreaterThanOrEqual(1);
    const options = Array.from(selects[0].querySelectorAll("option")).map(
      (opt) => opt.value,
    );
    expect(options).toContain("claude_code_local");
  });

  it("calls setGeneralAgentEngine when engine is changed to claude_code_local", async () => {
    const mockSetGeneralAgentEngine = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setGeneralAgentEngine")
        return mockSetGeneralAgentEngine;
      return vi.fn();
    });
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "claude_code_local" } });
      await Promise.resolve();
    });

    expect(mockSetGeneralAgentEngine).toHaveBeenCalledWith({
      engine: "claude_code_local",
    });
  });

  it("rolls back runtime changes and shows an error when saving fails", async () => {
    const mockSetGeneralAgentEngine = vi
      .fn()
      .mockRejectedValueOnce(new Error("Runtime save failed"));
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setGeneralAgentEngine")
        return mockSetGeneralAgentEngine;
      return vi.fn();
    });
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "codex_local" } });
      await Promise.resolve();
    });

    await waitFor(() => {
      const nextSelects = document.querySelectorAll(
        ".settings-runtime-select",
      ) as NodeListOf<HTMLSelectElement>;
      expect(nextSelects[0].value).toBe("default");
      expect(screen.getByText("Runtime save failed")).toBeTruthy();
    });
  });

  it("calls setCodexLocalMaxConcurrency when Codex concurrency changes", async () => {
    const mockSetCodexLocalMaxConcurrency = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setCodexLocalMaxConcurrency")
        return mockSetCodexLocalMaxConcurrency;
      return vi.fn();
    });
    setupUseQuery({
      generalAgentEngine: "codex_local",
      codexLocalMaxConcurrency: 3,
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-runtime-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: "1" } });
      await Promise.resolve();
    });

    expect(mockSetCodexLocalMaxConcurrency).toHaveBeenCalledWith({ value: 1 });
  });
});

describe("ModelConfigSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders Model Configuration title and description", async () => {
    setupUseQuery();
    await renderModelsTab();

    expect(screen.getByText("Model Configuration")).toBeTruthy();
    expect(
      screen.getByText("Override the default model for each agent type."),
    ).toBeTruthy();
  });

  it("renders all configurable agents with labels and descriptions", async () => {
    setupUseQuery();
    await renderModelsTab();

    // Agent labels
    expect(screen.getByText("Orchestrator")).toBeTruthy();
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();

    // Agent descriptions
    expect(
      screen.getByText("Top-level agent that delegates tasks"),
    ).toBeTruthy();
    expect(screen.getByText("Full tool access for general tasks")).toBeTruthy();
    expect(screen.getByText("Browser automation via Playwright")).toBeTruthy();
    expect(screen.getByText("Lightweight read-only exploration")).toBeTruthy();
  });

  it("shows default model labels in select dropdowns", async () => {
    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects.length).toBe(4);

    // Check that defaults appear as the first option in each select
    const defaultTexts = Array.from(selects).map((sel) => {
      const firstOption = sel.querySelector("option");
      return firstOption?.textContent;
    });

    expect(defaultTexts).toContain("Stella Recommended (currently Kimi K2.5)");
    expect(defaultTexts).toContain(
      "Stella Recommended (currently Claude Sonnet 4.6)",
    );
    expect(defaultTexts).toContain("Stella Recommended (currently GLM 4.7)");
  });

  it("shows model options from the catalog in optgroups", async () => {
    setupUseQuery();
    await renderModelsTab();

    const optgroups = document.querySelectorAll("optgroup");
    expect(optgroups.length).toBeGreaterThanOrEqual(2);

    const labels = Array.from(optgroups).map((og) => og.getAttribute("label"));
    expect(labels).toContain("anthropic");
    expect(labels).toContain("openai");
  });

  it("selects have current value from overrides", async () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    // First select is orchestrator
    expect(selects[0].value).toBe("openai/gpt-4o");
    // Second select (general) should be empty (default)
    expect(selects[1].value).toBe("");
  });

  it("treats explicit default overrides as the default option", async () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "stella/default" }),
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    expect(selects[0].value).toBe("");
    expect(
      document.querySelectorAll(".settings-model-reset-icon"),
    ).toHaveLength(0);
  });

  it("shows reset icon when agent has an override", async () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    // Reset icons should exist for agents with overrides
    const resetIcons = document.querySelectorAll(".settings-model-reset-icon");
    expect(resetIcons.length).toBe(1);
  });

  it("does not show reset icon when agent has no override", async () => {
    setupUseQuery({ modelOverrides: JSON.stringify({}) });
    await renderModelsTab();

    const resetIcons = document.querySelectorAll(".settings-model-reset-icon");
    expect(resetIcons.length).toBe(0);
  });

  it("shows Reset All button when there are overrides", async () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    const resetAllBtn = screen.getByText("Reset All");
    expect(resetAllBtn).toBeTruthy();
    expect((resetAllBtn as HTMLElement).style.visibility).toBe("visible");
  });

  it("hides Reset All button when there are no overrides", async () => {
    setupUseQuery({ modelOverrides: JSON.stringify({}) });
    await renderModelsTab();

    const resetAllBtn = screen.getByText("Reset All");
    expect((resetAllBtn as HTMLElement).style.visibility).toBe("hidden");
  });

  it("calls setModelOverride mutation when a model is selected", async () => {
    const mockSetOverride = vi.fn();
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setModelOverride") return mockSetOverride;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "openai/gpt-4o" } });
      await Promise.resolve();
    });

    expect(mockSetOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
      model: "openai/gpt-4o",
    });
  });

  it("rolls back model override changes and shows an error when saving fails", async () => {
    const mockSetOverride = vi
      .fn()
      .mockRejectedValueOnce(new Error("Model save failed"));
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setModelOverride") return mockSetOverride;
      return vi.fn();
    });

    setupUseQuery();
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "openai/gpt-4o" } });
      await Promise.resolve();
    });

    await waitFor(() => {
      const nextSelects = document.querySelectorAll(
        ".settings-model-select",
      ) as NodeListOf<HTMLSelectElement>;
      expect(nextSelects[0].value).toBe("");
      expect(screen.getByText("Model save failed")).toBeTruthy();
    });
    expect(
      document.querySelectorAll(".settings-model-reset-icon"),
    ).toHaveLength(0);
  });

  it("calls clearModelOverride mutation when empty value is selected", async () => {
    const mockSetOverride = vi.fn();
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setModelOverride") return mockSetOverride;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    const selects = document.querySelectorAll(
      ".settings-model-select",
    ) as NodeListOf<HTMLSelectElement>;
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "" } });
      await Promise.resolve();
    });

    expect(mockClearOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
    });
  });

  it("calls clearModelOverride when reset icon is clicked", async () => {
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    await renderModelsTab();

    const resetIcon = document.querySelector(
      ".settings-model-reset-icon",
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(resetIcon);
      await Promise.resolve();
    });

    expect(mockClearOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
    });
  });

  it("Reset All clears all overrides", async () => {
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery({
      modelOverrides: JSON.stringify({
        orchestrator: "openai/gpt-4o",
        general: "anthropic/claude-3",
      }),
    });
    await renderModelsTab();

    await act(async () => {
      fireEvent.click(screen.getByText("Reset All"));
      await Promise.resolve();
    });

    // Should be called for each overridden agent
    expect(mockClearOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
    });
    expect(mockClearOverride).toHaveBeenCalledWith({ agentType: "general" });
    expect(mockClearOverride).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: ApiKeysSection
// ---------------------------------------------------------------------------

describe("ApiKeysSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders API Keys title and description", async () => {
    setupUseQuery();
    await renderModelsTab();

    expect(screen.getByText("API Keys")).toBeTruthy();
    expect(screen.getByText(/Keys stay on this device/)).toBeTruthy();
    expect(
      screen.getByText(/Otherwise it uses your Stella provider access\./),
    ).toBeTruthy();
  });

  it("renders all LLM provider rows", async () => {
    setupUseQuery();
    await renderModelsTab();

    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("Google")).toBeTruthy();
    expect(screen.getByText("Kimi (Moonshot AI)")).toBeTruthy();
    expect(screen.getByText("Z.AI")).toBeTruthy();
    expect(screen.getByText("xAI")).toBeTruthy();
    expect(screen.getByText("Groq")).toBeTruthy();
    expect(screen.getByText("Mistral")).toBeTruthy();
    expect(screen.getByText("Cerebras")).toBeTruthy();
    expect(screen.getByText("OpenRouter")).toBeTruthy();
    expect(screen.getByText("Vercel AI Gateway")).toBeTruthy();
    expect(screen.getByText("OpenCode Zen")).toBeTruthy();
  });

  it("shows 'No key' status when no local credentials exist", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(LLM_PROVIDER_ROW_COUNT);
  });

  it("shows 'Key set' status when a local credential exists for a provider", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "anthropic", label: "Anthropic", status: "active" },
    ]);
    await renderModelsTab();

    expect(screen.getByText("Key set")).toBeTruthy();
    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(LLM_PROVIDER_ROW_COUNT - 1);
  });

  it("shows 'Add Key' button when provider has no local credential", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");
    expect(addKeyButtons.length).toBe(LLM_PROVIDER_ROW_COUNT);
  });

  it("shows 'Update Key' and 'Remove' buttons when provider has a local credential", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "anthropic", label: "Anthropic", status: "active" },
    ]);
    await renderModelsTab();

    expect(screen.getByText("Update Key")).toBeTruthy();
    expect(screen.getByText("Remove")).toBeTruthy();
  });

  it("shows input field with Save/Cancel when Add Key is clicked", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    expect(input).toBeTruthy();
    expect(screen.getByText("Save")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("hides input field when Cancel is clicked", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    expect(screen.getByPlaceholderText("sk-ant-...")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByPlaceholderText("sk-ant-...")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("calls saveLlmCredential when Save is clicked with input", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-test-key-123" } });

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(mockSaveLlmCredential).toHaveBeenCalledWith({
      provider: "anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-test-key-123",
    });
  });

  it("does not call saveLlmCredential when Save is clicked with empty input", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(mockSaveLlmCredential).not.toHaveBeenCalled();
  });

  it("calls saveLlmCredential when updating an existing key", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "anthropic", label: "Anthropic", status: "active" },
    ]);
    await renderModelsTab();

    fireEvent.click(screen.getByText("Update Key"));

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-new-key" } });

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(mockSaveLlmCredential).toHaveBeenCalledWith({
      provider: "anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-new-key",
    });
  });

  it("calls deleteLlmCredential when Remove button is clicked", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "anthropic", label: "Anthropic", status: "active" },
    ]);
    await renderModelsTab();

    await act(async () => {
      fireEvent.click(screen.getByText("Remove"));
    });

    expect(mockDeleteLlmCredential).toHaveBeenCalledWith("anthropic");
  });

  it("calls saveLlmCredential on Enter keypress in input", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-enter-key" } });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(mockSaveLlmCredential).toHaveBeenCalledWith({
      provider: "anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-enter-key",
    });
  });

  it("closes input on Escape keypress", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByPlaceholderText("sk-ant-...")).toBeNull();
  });

  it("only shows Remove button for providers that have an active local credential", async () => {
    setupUseQuery();
    setupElectronApi([
      { provider: "openai", label: "OpenAI", status: "active" },
    ]);
    await renderModelsTab();

    const removeButtons = screen.getAllByText("Remove");
    expect(removeButtons.length).toBe(1);
  });

  it("does not show 'Key set' when no local credentials exist", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(LLM_PROVIDER_ROW_COUNT);
    expect(screen.queryByText("Key set")).toBeNull();
  });

  it("shows correct placeholders for each provider", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");

    fireEvent.click(addKeyButtons[0]);
    expect(screen.getByPlaceholderText("sk-ant-...")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(addKeyButtons[1]);
    expect(screen.getByPlaceholderText("sk-...")).toBeTruthy();
  });

  it("input is of type password", async () => {
    setupUseQuery();
    setupElectronApi([]);
    await renderModelsTab();

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...") as HTMLInputElement;
    expect(input.type).toBe("password");
  });
});

// ---------------------------------------------------------------------------
// Tests: SettingsPanel scroll behavior
// ---------------------------------------------------------------------------

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupElectronApi();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders the settings-panel-wrap container", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const wrap = document.querySelector(".settings-panel-wrap");
    expect(wrap).toBeTruthy();
  });

  it("renders the settings-panel scroll container", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const panel = document.querySelector(".settings-panel");
    expect(panel).toBeTruthy();
  });
});



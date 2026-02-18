import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useQuery, useMutation } from "convex/react";
import SettingsDialog from "./SettingsView";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => undefined),
  useMutation: vi.fn(() => vi.fn()),
}));

vi.mock("@/convex/api", () => ({
  api: {
    data: {
      preferences: {
        getModelOverrides: "preferences.getModelOverrides",
        setModelOverride: "preferences.setModelOverride",
        clearModelOverride: "preferences.clearModelOverride",
      },
      secrets: {
        listSecrets: "secrets.listSecrets",
        createSecret: "secrets.createSecret",
        deleteSecret: "secrets.deleteSecret",
      },
    },
  },
}));

vi.mock("../../hooks/use-model-catalog", () => ({
  useModelCatalog: vi.fn(() => ({
    models: [
      { id: "anthropic/claude-3", name: "Claude 3", provider: "anthropic" },
      { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
    ],
    groups: [
      { provider: "anthropic", models: [{ id: "anthropic/claude-3", name: "Claude 3" }] },
      { provider: "openai", models: [{ id: "openai/gpt-4o", name: "GPT-4o" }] },
    ],
    loading: false,
  })),
}));

// Lightweight mock of the Radix-based Dialog components so that the dialog
// content is rendered synchronously in jsdom when `open` is true.
vi.mock("@/components/dialog", () => ({
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
    onOpenRuntimeMode: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  };
}

function mockUseQuery(
  impl: (queryPath: unknown, args?: unknown) => unknown,
) {
  vi.mocked(useQuery).mockImplementation(impl as any);
}

function mockUseMutation(
  impl: (mutationPath: unknown) => unknown,
) {
  vi.mocked(useMutation).mockImplementation(impl as any);
}

/**
 * Configure useQuery mock to return different values based on query key.
 */
function setupUseQuery(opts: {
  modelOverrides?: string;
  secrets?: Array<{ _id: string; provider: string; label: string; status: string }>;
} = {}) {
  mockUseQuery((queryPath: unknown) => {
    const path = queryPath as string;
    if (path === "preferences.getModelOverrides") {
      return opts.modelOverrides ?? undefined;
    }
    if (path === "secrets.listSecrets") {
      return opts.secrets ?? undefined;
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Tests: Dialog rendering
// ---------------------------------------------------------------------------

describe("SettingsDialog rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("shows BasicTab content by default (Runtime Mode, Sign Out, etc)", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Runtime Mode")).toBeTruthy();
    // "Sign Out" appears as both label and button
    const signOutElements = screen.getAllByText("Sign Out");
    expect(signOutElements.length).toBeGreaterThanOrEqual(2);
  });

  it("switches to Models tab when clicked", () => {
    render(<SettingsDialog {...defaultProps()} />);

    fireEvent.click(screen.getByText("Models"));

    // Models tab should now be active
    expect(screen.getByText("Models").className).toContain("settings-sidebar-tab--active");
    expect(screen.getByText("Basic").className).not.toContain("settings-sidebar-tab--active");

    // Models tab content should appear
    expect(screen.getByText("Model Configuration")).toBeTruthy();
    expect(screen.getByText("API Keys")).toBeTruthy();

    // Basic tab content should be hidden
    expect(screen.queryByText("Runtime Mode")).toBeNull();
  });

  it("switches back to Basic tab from Models", () => {
    render(<SettingsDialog {...defaultProps()} />);

    fireEvent.click(screen.getByText("Models"));
    expect(screen.queryByText("Runtime Mode")).toBeNull();

    fireEvent.click(screen.getByText("Basic"));
    expect(screen.getByText("Runtime Mode")).toBeTruthy();
    expect(screen.queryByText("Model Configuration")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: BasicTab
// ---------------------------------------------------------------------------

describe("BasicTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders Runtime Mode row with Configure button", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Runtime Mode")).toBeTruthy();
    expect(screen.getByText("Configure local or 24/7 cloud execution")).toBeTruthy();

    const configureBtn = screen.getAllByRole("button").find(
      (btn) => btn.textContent === "Configure",
    );
    expect(configureBtn).toBeTruthy();
  });

  it("calls onOpenRuntimeMode when Configure button is clicked", () => {
    const onOpenRuntimeMode = vi.fn();
    render(<SettingsDialog {...defaultProps({ onOpenRuntimeMode })} />);

    const configureBtn = screen.getAllByRole("button").find(
      (btn) => btn.textContent === "Configure",
    );
    fireEvent.click(configureBtn!);
    expect(onOpenRuntimeMode).toHaveBeenCalledTimes(1);
  });

  it("renders Sign Out row with Sign Out button", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Sign out of your account")).toBeTruthy();

    const signOutBtn = screen.getAllByRole("button").find(
      (btn) => btn.textContent === "Sign Out",
    );
    expect(signOutBtn).toBeTruthy();
  });

  it("calls onSignOut when Sign Out button is clicked", () => {
    const onSignOut = vi.fn();
    render(<SettingsDialog {...defaultProps({ onSignOut })} />);

    const signOutBtn = screen.getAllByRole("button").find(
      (btn) => btn.textContent === "Sign Out",
    );
    fireEvent.click(signOutBtn!);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("renders Delete Data row with danger-styled Delete button", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Delete Data")).toBeTruthy();
    expect(screen.getByText("Erase all conversations and memories")).toBeTruthy();

    const deleteButtons = screen.getAllByRole("button").filter(
      (btn) => btn.textContent === "Delete",
    );
    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
    expect(deleteButtons[0].className).toContain("settings-btn--danger");
  });

  it("renders Delete Account row with danger-styled Delete button", () => {
    render(<SettingsDialog {...defaultProps()} />);
    expect(screen.getByText("Delete Account")).toBeTruthy();
    expect(screen.getByText("Permanently remove your account and all data")).toBeTruthy();

    const deleteButtons = screen.getAllByRole("button").filter(
      (btn) => btn.textContent === "Delete",
    );
    // There should be two Delete buttons: Delete Data and Delete Account
    expect(deleteButtons.length).toBe(2);
    expect(deleteButtons[1].className).toContain("settings-btn--danger");
  });

  it("renders all four BasicTab rows", () => {
    render(<SettingsDialog {...defaultProps()} />);
    const rows = document.querySelectorAll(".settings-row");
    expect(rows.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Tests: ModelConfigSection
// ---------------------------------------------------------------------------

describe("ModelConfigSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders Model Configuration title and description", () => {
    setupUseQuery();
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    expect(screen.getByText("Model Configuration")).toBeTruthy();
    expect(screen.getByText("Override the default model for each agent type.")).toBeTruthy();
  });

  it("renders all configurable agents with labels and descriptions", () => {
    setupUseQuery();
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    // Agent labels
    expect(screen.getByText("Orchestrator")).toBeTruthy();
    expect(screen.getByText("General")).toBeTruthy();
    expect(screen.getByText("Self-Mod")).toBeTruthy();
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.getByText("Memory")).toBeTruthy();

    // Agent descriptions
    expect(screen.getByText("Top-level agent that delegates tasks")).toBeTruthy();
    expect(screen.getByText("Full tool access for general tasks")).toBeTruthy();
    expect(screen.getByText("Platform self-modification agent")).toBeTruthy();
    expect(screen.getByText("Browser automation via Playwright")).toBeTruthy();
    expect(screen.getByText("Lightweight read-only exploration")).toBeTruthy();
    expect(screen.getByText("Memory search and retrieval")).toBeTruthy();
  });

  it("shows default model labels in select dropdowns", () => {
    setupUseQuery();
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const selects = document.querySelectorAll(".settings-model-select") as NodeListOf<HTMLSelectElement>;
    expect(selects.length).toBe(6);

    // Check that defaults appear as the first option in each select
    const defaultTexts = Array.from(selects).map((sel) => {
      const firstOption = sel.querySelector("option");
      return firstOption?.textContent;
    });

    expect(defaultTexts).toContain("anthropic/claude-opus-4.6");
    expect(defaultTexts).toContain("moonshotai/kimi-k2.5");
    expect(defaultTexts).toContain("zai/glm-4.7");
  });

  it("shows model options from the catalog in optgroups", () => {
    setupUseQuery();
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const optgroups = document.querySelectorAll("optgroup");
    expect(optgroups.length).toBeGreaterThanOrEqual(2);

    const labels = Array.from(optgroups).map((og) => og.getAttribute("label"));
    expect(labels).toContain("anthropic");
    expect(labels).toContain("openai");
  });

  it("selects have current value from overrides", () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const selects = document.querySelectorAll(".settings-model-select") as NodeListOf<HTMLSelectElement>;
    // First select is orchestrator
    expect(selects[0].value).toBe("openai/gpt-4o");
    // Second select (general) should be empty (default)
    expect(selects[1].value).toBe("");
  });

  it("shows reset icon when agent has an override", () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    // Reset icons should exist for agents with overrides
    const resetIcons = document.querySelectorAll(".settings-model-reset-icon");
    expect(resetIcons.length).toBe(1);
  });

  it("does not show reset icon when agent has no override", () => {
    setupUseQuery({ modelOverrides: undefined });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const resetIcons = document.querySelectorAll(".settings-model-reset-icon");
    expect(resetIcons.length).toBe(0);
  });

  it("shows Reset All button when there are overrides", () => {
    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const resetAllBtn = screen.getByText("Reset All");
    expect(resetAllBtn).toBeTruthy();
    expect((resetAllBtn as HTMLElement).style.visibility).toBe("visible");
  });

  it("hides Reset All button when there are no overrides", () => {
    setupUseQuery({ modelOverrides: undefined });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const resetAllBtn = screen.getByText("Reset All");
    expect((resetAllBtn as HTMLElement).style.visibility).toBe("hidden");
  });

  it("calls setModelOverride mutation when a model is selected", () => {
    const mockSetOverride = vi.fn();
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.setModelOverride") return mockSetOverride;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery();
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const selects = document.querySelectorAll(".settings-model-select") as NodeListOf<HTMLSelectElement>;
    fireEvent.change(selects[0], { target: { value: "openai/gpt-4o" } });

    expect(mockSetOverride).toHaveBeenCalledWith({
      agentType: "orchestrator",
      model: "openai/gpt-4o",
    });
  });

  it("calls clearModelOverride mutation when empty value is selected", () => {
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
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const selects = document.querySelectorAll(".settings-model-select") as NodeListOf<HTMLSelectElement>;
    fireEvent.change(selects[0], { target: { value: "" } });

    expect(mockClearOverride).toHaveBeenCalledWith({ agentType: "orchestrator" });
  });

  it("calls clearModelOverride when reset icon is clicked", () => {
    const mockClearOverride = vi.fn();
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "preferences.clearModelOverride") return mockClearOverride;
      return vi.fn();
    });

    setupUseQuery({
      modelOverrides: JSON.stringify({ orchestrator: "openai/gpt-4o" }),
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const resetIcon = document.querySelector(".settings-model-reset-icon") as HTMLElement;
    fireEvent.click(resetIcon);

    expect(mockClearOverride).toHaveBeenCalledWith({ agentType: "orchestrator" });
  });

  it("Reset All clears all overrides", () => {
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
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    fireEvent.click(screen.getByText("Reset All"));

    // Should be called for each overridden agent
    expect(mockClearOverride).toHaveBeenCalledWith({ agentType: "orchestrator" });
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
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  });

  it("renders API Keys title and description", () => {
    setupUseQuery();
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    expect(screen.getByText("API Keys")).toBeTruthy();
    expect(screen.getByText(/Bring your own API keys/)).toBeTruthy();
  });

  it("renders all LLM provider rows", () => {
    setupUseQuery();
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
    expect(screen.getByText("Google")).toBeTruthy();
    expect(screen.getByText("OpenRouter")).toBeTruthy();
    expect(screen.getByText("Vercel AI Gateway")).toBeTruthy();
  });

  it("shows 'No key' status when no secrets exist", () => {
    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(5); // one for each provider
  });

  it("shows 'Key set' status when secret exists for a provider", () => {
    setupUseQuery({
      secrets: [
        { _id: "s1", provider: "llm:anthropic", label: "Anthropic", status: "active" },
      ],
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    expect(screen.getByText("Key set")).toBeTruthy();
    // The other four should show "No key"
    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(4);
  });

  it("shows 'Add Key' button when provider has no secret", () => {
    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const addKeyButtons = screen.getAllByText("Add Key");
    expect(addKeyButtons.length).toBe(5);
  });

  it("shows 'Update Key' and 'Remove' buttons when provider has a secret", () => {
    setupUseQuery({
      secrets: [
        { _id: "s1", provider: "llm:anthropic", label: "Anthropic", status: "active" },
      ],
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    expect(screen.getByText("Update Key")).toBeTruthy();
    expect(screen.getByText("Remove")).toBeTruthy();
  });

  it("shows input field with Save/Cancel when Add Key is clicked", () => {
    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    // Click the first "Add Key" (Anthropic)
    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    // Input should appear with placeholder
    const input = screen.getByPlaceholderText("sk-ant-...");
    expect(input).toBeTruthy();
    expect(screen.getByText("Save")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("hides input field when Cancel is clicked", () => {
    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    expect(screen.getByPlaceholderText("sk-ant-...")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByPlaceholderText("sk-ant-...")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("calls createSecret mutation when Save is clicked with input", async () => {
    const mockCreateSecret = vi.fn().mockResolvedValue(undefined);
    const mockDeleteSecret = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "secrets.createSecret") return mockCreateSecret;
      if (path === "secrets.deleteSecret") return mockDeleteSecret;
      return vi.fn();
    });

    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    // Click Add Key for Anthropic
    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    // Type a key
    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-test-key-123" } });

    // Click Save
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(mockCreateSecret).toHaveBeenCalledWith({
      provider: "llm:anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-test-key-123",
      metadata: undefined,
    });
  });

  it("does not call createSecret when Save is clicked with empty input", async () => {
    const mockCreateSecret = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "secrets.createSecret") return mockCreateSecret;
      return vi.fn();
    });

    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    // Don't type anything, just click Save
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(mockCreateSecret).not.toHaveBeenCalled();
  });

  it("calls deleteSecret then createSecret when updating an existing key", async () => {
    const mockCreateSecret = vi.fn().mockResolvedValue(undefined);
    const mockDeleteSecret = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "secrets.createSecret") return mockCreateSecret;
      if (path === "secrets.deleteSecret") return mockDeleteSecret;
      return vi.fn();
    });

    setupUseQuery({
      secrets: [
        { _id: "s1", provider: "llm:anthropic", label: "Anthropic", status: "active" },
      ],
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    // Click Update Key
    fireEvent.click(screen.getByText("Update Key"));

    // Type new key
    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-new-key" } });

    // Click Save
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    // Should delete old key first, then create new one
    expect(mockDeleteSecret).toHaveBeenCalledWith({ secretId: "s1" });
    expect(mockCreateSecret).toHaveBeenCalledWith({
      provider: "llm:anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-new-key",
      metadata: undefined,
    });
  });

  it("calls deleteSecret when Remove button is clicked", async () => {
    const mockDeleteSecret = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "secrets.deleteSecret") return mockDeleteSecret;
      return vi.fn();
    });

    setupUseQuery({
      secrets: [
        { _id: "s1", provider: "llm:anthropic", label: "Anthropic", status: "active" },
      ],
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    await act(async () => {
      fireEvent.click(screen.getByText("Remove"));
    });

    expect(mockDeleteSecret).toHaveBeenCalledWith({ secretId: "s1" });
  });

  it("calls createSecret on Enter keypress in input", async () => {
    const mockCreateSecret = vi.fn().mockResolvedValue(undefined);
    mockUseMutation((mutationPath: unknown) => {
      const path = mutationPath as string;
      if (path === "secrets.createSecret") return mockCreateSecret;
      return vi.fn();
    });

    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.change(input, { target: { value: "sk-ant-enter-key" } });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(mockCreateSecret).toHaveBeenCalledWith({
      provider: "llm:anthropic",
      label: "Anthropic",
      plaintext: "sk-ant-enter-key",
      metadata: undefined,
    });
  });

  it("closes input on Escape keypress", () => {
    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    const addKeyButtons = screen.getAllByText("Add Key");
    fireEvent.click(addKeyButtons[0]);

    const input = screen.getByPlaceholderText("sk-ant-...");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByPlaceholderText("sk-ant-...")).toBeNull();
  });

  it("only shows Remove button for providers that have an active secret", () => {
    setupUseQuery({
      secrets: [
        { _id: "s1", provider: "llm:openai", label: "OpenAI", status: "active" },
      ],
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    // Only one Remove button should exist (for OpenAI)
    const removeButtons = screen.getAllByText("Remove");
    expect(removeButtons.length).toBe(1);
  });

  it("does not treat inactive secrets as key set", () => {
    setupUseQuery({
      secrets: [
        { _id: "s1", provider: "llm:anthropic", label: "Anthropic", status: "revoked" },
      ],
    });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    // All providers should show "No key" since the only secret is revoked
    const noKeyStatuses = screen.getAllByText("No key");
    expect(noKeyStatuses.length).toBe(5);
    expect(screen.queryByText("Key set")).toBeNull();
  });

  it("shows correct placeholders for each provider", () => {
    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

    // Click each Add Key and check placeholder (use first one as example)
    const addKeyButtons = screen.getAllByText("Add Key");

    // Click Anthropic's Add Key
    fireEvent.click(addKeyButtons[0]);
    expect(screen.getByPlaceholderText("sk-ant-...")).toBeTruthy();

    // Cancel and try OpenAI
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(addKeyButtons[1]);
    expect(screen.getByPlaceholderText("sk-...")).toBeTruthy();
  });

  it("input is of type password", () => {
    setupUseQuery({ secrets: [] });
    render(<SettingsDialog {...defaultProps()} />);
    fireEvent.click(screen.getByText("Models"));

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

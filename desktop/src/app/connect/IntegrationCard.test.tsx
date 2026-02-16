import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Integration } from "./integration-configs";
import { IntegrationDetailArea, IntegrationGridCard } from "./IntegrationCard";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockUseAction = vi.fn();
const mockShowToast = vi.fn();
const mockDeployAndStartLocalBridge = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useAction: (...args: unknown[]) => mockUseAction(...args),
}));

vi.mock("@/components/toast", () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

vi.mock("@/lib/bridge-local", () => ({
  deployAndStartLocalBridge: (...args: unknown[]) =>
    mockDeployAndStartLocalBridge(...args),
}));

const makeIntegration = (overrides: Partial<Integration>): Integration => ({
  provider: "discord",
  displayName: "Discord",
  type: "bot",
  group: "messaging",
  brandColor: "#5865F2",
  icon: <span>D</span>,
  instructions: "Send Stella your code",
  ...overrides,
});

describe("IntegrationCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeployAndStartLocalBridge.mockResolvedValue(true);

    mockUseMutation.mockReturnValue(
      vi.fn(async (args: Record<string, unknown>) => {
        if (args && args.provider === "discord") {
          return { code: "ABC123" };
        }
        if (args && Object.keys(args).length === 0) {
          return { url: "https://slack.example/install" };
        }
        return null;
      }),
    );

    mockUseAction.mockReturnValue(vi.fn().mockResolvedValue(null));

    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: {
        writeText: vi.fn(),
      },
      configurable: true,
    });

    window.electronAPI = {
      bridgeStop: vi.fn().mockResolvedValue({ ok: true }),
      bridgeStatus: vi.fn().mockResolvedValue({ running: true }),
    } as unknown as typeof window.electronAPI;
  });

  it("shows connected badge in grid card when connection exists", () => {
    const onClick = vi.fn();
    mockUseQuery.mockReturnValue({ _id: "conn-1" });

    const { container } = render(
      <IntegrationGridCard
        integration={makeIntegration({})}
        isSelected={false}
        onClick={onClick}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".connect-grid-card-badge")).toBeTruthy();
  });

  it("renders bot setup, loads link code, and copies it", async () => {
    mockUseQuery.mockReturnValue(null);

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "discord",
          displayName: "Discord",
          botLink: "https://discord.example/bot",
        })}
      />,
    );

    expect(screen.getByText("Send Stella your code")).toBeInTheDocument();

    expect(await screen.findByText("ABC123")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ABC123");
    expect(mockShowToast).toHaveBeenCalledWith("Code copied to clipboard");
    expect(screen.getByRole("link", { name: /Find bot on Discord/i })).toBeInTheDocument();
  });

  it("disconnects a connected bridge integration and shows success toast", async () => {
    const actionFn = vi.fn().mockResolvedValue(null);
    const mutationFn = vi.fn().mockResolvedValue(null);

    mockUseQuery.mockReturnValue({ _id: "conn-2" });
    mockUseAction.mockReturnValue(actionFn);
    mockUseMutation.mockReturnValue(mutationFn);

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "signal",
          displayName: "Signal",
          type: "bridge",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(window.electronAPI?.bridgeStop).toHaveBeenCalledWith({ provider: "signal" });
    });
    expect(actionFn).toHaveBeenCalledWith({ provider: "signal" });
    expect(mutationFn).toHaveBeenCalledWith({ provider: "signal" });
    expect(mockShowToast).toHaveBeenCalledWith("Disconnected from Signal");
  });

  it("shows failure toast when disconnect fails", async () => {
    const actionFn = vi.fn().mockResolvedValue(null);
    const mutationFn = vi.fn().mockRejectedValue(new Error("delete failed"));

    mockUseQuery.mockReturnValue({ _id: "conn-3" });
    mockUseAction.mockReturnValue(actionFn);
    mockUseMutation.mockReturnValue(mutationFn);

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "discord",
          displayName: "Discord",
          type: "bot",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith("Failed to disconnect from Discord");
    });
  });

  it("renders WhatsApp bridge QR and starts local bridge when needed", async () => {
    const setupBridge = vi.fn().mockResolvedValue({ status: "initializing" });
    const getBridgeBundle = vi.fn();
    let actionCalls = 0;
    mockUseAction.mockImplementation(() => {
      actionCalls += 1;
      return actionCalls % 2 === 1 ? setupBridge : getBridgeBundle;
    });

    mockUseQuery.mockImplementation((_ref: unknown, args?: unknown) => {
      if (args && typeof args === "object" && "provider" in (args as Record<string, unknown>)) {
        return null; // getConnection
      }
      if (args === undefined) return "local"; // runtimeMode
      if (args && typeof args === "object" && Object.keys(args as Record<string, unknown>).length === 0) {
        return "data:image/png;base64,abc"; // WhatsApp QR code
      }
      return null;
    });

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "whatsapp",
          displayName: "WhatsApp",
          type: "bridge",
        })}
      />,
    );

    expect(screen.getByAltText("WhatsApp QR Code")).toBeInTheDocument();

    await waitFor(() => {
      expect(mockDeployAndStartLocalBridge).toHaveBeenCalledWith(
        "whatsapp",
        getBridgeBundle,
      );
    });
  });

  it("renders Signal bridge link and copies it", async () => {
    const setupBridge = vi.fn().mockResolvedValue({ status: "connected" });
    const getBridgeBundle = vi.fn();
    let actionCalls = 0;
    mockUseAction.mockImplementation(() => {
      actionCalls += 1;
      return actionCalls % 2 === 1 ? setupBridge : getBridgeBundle;
    });

    mockUseQuery.mockImplementation((_ref: unknown, args?: unknown) => {
      if (args && typeof args === "object" && "provider" in (args as Record<string, unknown>)) {
        return null;
      }
      if (args === undefined) return "local";
      if (args && typeof args === "object" && Object.keys(args as Record<string, unknown>).length === 0) {
        return "sgnl://link-device";
      }
      return null;
    });

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "signal",
          displayName: "Signal",
          type: "bridge",
        })}
      />,
    );

    expect(screen.getByText("sgnl://link-device")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("sgnl://link-device");
    expect(mockShowToast).toHaveBeenCalledWith("Link copied to clipboard");
  });

  it("shows bridge setup error when setup fails", async () => {
    const setupBridge = vi.fn().mockRejectedValue(new Error("Bridge setup failed"));
    const getBridgeBundle = vi.fn();
    let actionCalls = 0;
    mockUseAction.mockImplementation(() => {
      actionCalls += 1;
      return actionCalls % 2 === 1 ? setupBridge : getBridgeBundle;
    });

    mockUseQuery.mockImplementation((_ref: unknown, args?: unknown) => {
      if (args && typeof args === "object" && "provider" in (args as Record<string, unknown>)) {
        return null;
      }
      if (args === undefined) return "local";
      if (args && typeof args === "object" && Object.keys(args as Record<string, unknown>).length === 0) {
        return null;
      }
      return null;
    });

    render(
      <IntegrationDetailArea
        integration={makeIntegration({
          provider: "whatsapp",
          displayName: "WhatsApp",
          type: "bridge",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Bridge setup failed")).toBeInTheDocument();
    });
  });
});

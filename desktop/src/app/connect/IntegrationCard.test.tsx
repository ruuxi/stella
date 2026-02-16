import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Integration } from "./integration-configs";
import { IntegrationDetailArea, IntegrationGridCard } from "./IntegrationCard";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockUseAction = vi.fn();
const mockShowToast = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useAction: (...args: unknown[]) => mockUseAction(...args),
}));

vi.mock("@/components/toast", () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
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

    Object.defineProperty(global.navigator, "clipboard", {
      value: {
        writeText: vi.fn(),
      },
      configurable: true,
    });

    window.electronAPI = {
      bridgeStop: vi.fn().mockResolvedValue({ ok: true }),
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
});

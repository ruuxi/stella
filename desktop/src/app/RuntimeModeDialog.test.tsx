import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RuntimeModeDialog } from "./RuntimeModeDialog";

const mockUseQuery = vi.fn();
const mockSet247Enabled = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useAction: () => mockSet247Enabled,
}));

vi.mock("@/convex/api", () => ({
  api: {
    agent: {
      cloud_devices: {
        get247Status: "get247Status",
        set247Enabled: "set247Enabled",
      },
    },
  },
}));

vi.mock("@/components/button", () => ({
  Button: ({
    children,
    disabled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

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
        <button type="button" data-testid="dialog-close" onClick={() => onOpenChange(false)}>
          close
        </button>
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogCloseButton: () => <button type="button">X</button>,
}));

vi.mock("./RuntimeModeDialog.css", () => ({}));

describe("RuntimeModeDialog", () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue(undefined);
    mockSet247Enabled.mockResolvedValue({});
  });

  it("renders nothing when open is false", () => {
    render(<RuntimeModeDialog open={false} onOpenChange={onOpenChange} />);
    expect(screen.queryByText("Runtime Mode")).toBeNull();
  });

  it("renders title and description when open", () => {
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("Runtime Mode")).toBeTruthy();
    expect(
      screen.getByText(/Stella runs on your computer by default/),
    ).toBeTruthy();
  });

  it("shows loading status when runtimeStatus is undefined", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("Loading status...")).toBeTruthy();
  });

  it("shows 'Local-only mode' when disabled and no cloud device", () => {
    mockUseQuery.mockReturnValue({
      mode: "local",
      enabled: false,
      cloudDevice: null,
    });
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("Local-only mode")).toBeTruthy();
    expect(screen.getByText("Enable 24/7")).toBeTruthy();
  });

  it("shows provisioning status when enabled but no cloud device", () => {
    mockUseQuery.mockReturnValue({
      mode: "cloud_247",
      enabled: true,
      cloudDevice: null,
    });
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("24/7 enabled (provisioning...)")).toBeTruthy();
    expect(screen.getByText("Disable 24/7")).toBeTruthy();
  });

  it("shows full status when cloud device is present and enabled", () => {
    mockUseQuery.mockReturnValue({
      mode: "cloud_247",
      enabled: true,
      cloudDevice: {
        spriteName: "my-sprite",
        status: "running",
        setupComplete: true,
        lastActiveAt: Date.now(),
      },
    });
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("24/7 enabled - running (ready)")).toBeTruthy();
    expect(screen.getByText("Sprite: my-sprite")).toBeTruthy();
  });

  it("shows 'setting up' when setup is not complete", () => {
    mockUseQuery.mockReturnValue({
      mode: "cloud_247",
      enabled: true,
      cloudDevice: {
        spriteName: "my-sprite",
        status: "initializing",
        setupComplete: false,
        lastActiveAt: Date.now(),
      },
    });
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("24/7 enabled - initializing (setting up)")).toBeTruthy();
  });

  it("shows disabled status when cloud device present but disabled", () => {
    mockUseQuery.mockReturnValue({
      mode: "local",
      enabled: false,
      cloudDevice: {
        spriteName: "my-sprite",
        status: "stopped",
        setupComplete: true,
        lastActiveAt: Date.now(),
      },
    });
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("24/7 disabled - stopped (ready)")).toBeTruthy();
  });

  it("calls set247Enabled with true when enabling", async () => {
    mockUseQuery.mockReturnValue({
      mode: "local",
      enabled: false,
      cloudDevice: null,
    });
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText("Enable 24/7"));
    await waitFor(() => {
      expect(mockSet247Enabled).toHaveBeenCalledWith({ enabled: true });
    });
  });

  it("calls set247Enabled with false when disabling", async () => {
    mockUseQuery.mockReturnValue({
      mode: "cloud_247",
      enabled: true,
      cloudDevice: null,
    });
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByText("Disable 24/7"));
    await waitFor(() => {
      expect(mockSet247Enabled).toHaveBeenCalledWith({ enabled: false });
    });
  });

  it("shows 'Enabling 24/7...' while saving when currently disabled", async () => {
    let resolveToggle: () => void;
    mockSet247Enabled.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveToggle = resolve;
      }),
    );
    mockUseQuery.mockReturnValue({
      mode: "local",
      enabled: false,
      cloudDevice: null,
    });

    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText("Enable 24/7"));

    await waitFor(() => {
      expect(screen.getByText("Enabling 24/7...")).toBeTruthy();
    });

    resolveToggle!();
    await waitFor(() => {
      expect(screen.getByText("Enable 24/7")).toBeTruthy();
    });
  });

  it("shows 'Disabling 24/7...' while saving when currently enabled", async () => {
    let resolveToggle: () => void;
    mockSet247Enabled.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveToggle = resolve;
      }),
    );
    mockUseQuery.mockReturnValue({
      mode: "cloud_247",
      enabled: true,
      cloudDevice: null,
    });

    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText("Disable 24/7"));

    await waitFor(() => {
      expect(screen.getByText("Disabling 24/7...")).toBeTruthy();
    });

    resolveToggle!();
    await waitFor(() => {
      expect(screen.getByText("Disable 24/7")).toBeTruthy();
    });
  });

  it("displays error when toggle fails", async () => {
    mockSet247Enabled.mockRejectedValue(new Error("Toggle failed"));
    mockUseQuery.mockReturnValue({
      mode: "local",
      enabled: false,
      cloudDevice: null,
    });

    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText("Enable 24/7"));

    await waitFor(() => {
      expect(screen.getByText("Toggle failed")).toBeTruthy();
    });
  });

  it("disables button when runtimeStatus is undefined", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<RuntimeModeDialog open={true} onOpenChange={onOpenChange} />);
    const button = screen.getByText("Enable 24/7");
    expect(button).toBeDisabled();
  });

  it("skips query when dialog is closed", () => {
    render(<RuntimeModeDialog open={false} onOpenChange={onOpenChange} />);
    expect(mockUseQuery).toHaveBeenCalledWith("get247Status", "skip");
  });
});

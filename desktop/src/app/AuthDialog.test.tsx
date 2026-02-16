import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AuthDialog } from "./AuthDialog";

const mockUseConvexAuth = vi.fn();
vi.mock("convex/react", () => ({
  useConvexAuth: () => mockUseConvexAuth(),
}));

const mockFetch = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    $fetch: (...args: unknown[]) => mockFetch(...args),
  },
}));

vi.mock("@/components/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/text-field", () => ({
  TextField: ({
    label,
    value,
    onChange,
    ...props
  }: {
    label?: string;
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    type?: string;
    placeholder?: string;
    autoComplete?: string;
  }) => (
    <label>
      {label}
      <input value={value} onChange={onChange} aria-label={label} {...props} />
    </label>
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

vi.mock("./AuthDialog.css", () => ({}));

describe("AuthDialog", () => {
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    mockFetch.mockResolvedValue({});
    delete ((window as unknown as Record<string, unknown>)).electronAPI;
  });

  it("renders nothing when open is false", () => {
    render(<AuthDialog open={false} onOpenChange={onOpenChange} />);
    expect(screen.queryByText("Welcome to Stella")).toBeNull();
  });

  it("renders dialog content when open is true", () => {
    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.getByText("Welcome to Stella")).toBeTruthy();
    expect(screen.getByText("Sign in with your email.")).toBeTruthy();
    expect(screen.getByText("Send sign-in email")).toBeTruthy();
  });

  it("shows error when submitting empty email", async () => {
    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText("Send sign-in email"));
    await waitFor(() => {
      expect(screen.getByText("Enter an email address.")).toBeTruthy();
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends magic link request on valid email submit", async () => {
    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Check your inbox for the sign-in link.")).toBeTruthy();
    });
    expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
      method: "POST",
      body: { email: "test@example.com", callbackURL: expect.any(String) },
    });
  });

  it("shows 'Sending...' while request is in flight", async () => {
    let resolveRequest: () => void;
    mockFetch.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Sending...")).toBeTruthy();
    });

    resolveRequest!();
    await waitFor(() => {
      expect(screen.getByText("Check your inbox for the sign-in link.")).toBeTruthy();
    });
  });

  it("displays error message when magic link request fails", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeTruthy();
    });
  });

  it("displays fallback error message when error has no message", async () => {
    mockFetch.mockRejectedValue({});

    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Failed to send magic link.")).toBeTruthy();
    });
  });

  it("closes dialog when user becomes authenticated", () => {
    mockUseConvexAuth.mockReturnValue({ isAuthenticated: false });
    const { rerender } = render(<AuthDialog open={true} onOpenChange={onOpenChange} />);

    mockUseConvexAuth.mockReturnValue({ isAuthenticated: true });
    rerender(<AuthDialog open={true} onOpenChange={onOpenChange} />);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("resets state when dialog closes", () => {
    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("dialog-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("trims whitespace-only email and shows error", async () => {
    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(screen.getByText("Enter an email address.")).toBeTruthy();
    });
  });

  it("uses Electron protocol callback URL when electronAPI is present", async () => {
    ((window as unknown as Record<string, unknown>)).electronAPI = {};

    render(<AuthDialog open={true} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByText("Send sign-in email"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/sign-in/magic-link", {
        method: "POST",
        body: { email: "test@example.com", callbackURL: "Stella://auth" },
      });
    });
  });
});

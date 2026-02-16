import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CredentialModal } from "./CredentialModal";

vi.mock("./dialog", () => {
  const DialogRoot = ({
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
        <button type="button" data-testid="dialog-overlay" onClick={() => onOpenChange(false)}>
          overlay
        </button>
        {children}
      </div>
    ) : null;

  DialogRoot.Content = ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-content" className={className}>{children}</div>
  );
  DialogRoot.Header = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  );
  DialogRoot.Title = ({ children }: { children: React.ReactNode }) => (
    <h2 data-testid="dialog-title">{children}</h2>
  );
  DialogRoot.Description = ({ children }: { children: React.ReactNode }) => (
    <p data-testid="dialog-description">{children}</p>
  );
  DialogRoot.Body = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-body">{children}</div>
  );

  return { Dialog: DialogRoot };
});

describe("CredentialModal", () => {
  const defaultProps = {
    open: true,
    provider: "OpenAI",
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    defaultProps.onSubmit = vi.fn().mockResolvedValue(undefined);
    defaultProps.onCancel = vi.fn();
  });

  it("renders nothing when open is false", () => {
    render(<CredentialModal {...defaultProps} open={false} />);
    expect(screen.queryByTestId("dialog-root")).toBeNull();
  });

  it("renders provider name in title", () => {
    render(<CredentialModal {...defaultProps} />);
    expect(screen.getByTestId("dialog-title")).toHaveTextContent("Connect OpenAI");
  });

  it("renders default description when none provided", () => {
    render(<CredentialModal {...defaultProps} />);
    expect(screen.getByTestId("dialog-description")).toHaveTextContent(
      "Enter your API key. This is stored securely and never shown to the AI.",
    );
  });

  it("renders custom description when provided", () => {
    render(<CredentialModal {...defaultProps} description="Custom desc" />);
    expect(screen.getByTestId("dialog-description")).toHaveTextContent("Custom desc");
  });

  it("renders label field with provided default label", () => {
    render(<CredentialModal {...defaultProps} label="My Key" />);
    const labelInput = screen.getByDisplayValue("My Key");
    expect(labelInput).toBeTruthy();
  });

  it("renders label field empty when no default label", () => {
    render(<CredentialModal {...defaultProps} />);
    const inputs = screen.getAllByRole("textbox");
    // First textbox is the label input
    expect((inputs[0] as HTMLInputElement).value).toBe("");
  });

  it("renders custom placeholder on API key field", () => {
    render(<CredentialModal {...defaultProps} placeholder="sk-..." />);
    expect(screen.getByPlaceholderText("sk-...")).toBeTruthy();
  });

  it("renders default placeholder when none provided", () => {
    render(<CredentialModal {...defaultProps} />);
    expect(screen.getByPlaceholderText("Paste your key")).toBeTruthy();
  });

  it("shows error when submitting with empty secret", async () => {
    render(<CredentialModal {...defaultProps} />);
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("API key is required.")).toBeTruthy();
    });
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it("shows error when secret is whitespace only", async () => {
    render(<CredentialModal {...defaultProps} />);
    const secretInput = screen.getByPlaceholderText("Paste your key");
    fireEvent.change(secretInput, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("API key is required.")).toBeTruthy();
    });
  });

  it("calls onSubmit with trimmed values on valid submit", async () => {
    render(<CredentialModal {...defaultProps} />);

    const labelInput = screen.getByPlaceholderText("OpenAI key");
    const secretInput = screen.getByPlaceholderText("Paste your key");

    fireEvent.change(labelInput, { target: { value: "  My API Key  " } });
    fireEvent.change(secretInput, { target: { value: "  sk-abc123  " } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledWith({
        label: "My API Key",
        secret: "sk-abc123",
      });
    });
  });

  it("uses default label when label field is empty", async () => {
    render(<CredentialModal {...defaultProps} provider="Anthropic" />);

    const secretInput = screen.getByPlaceholderText("Paste your key");
    fireEvent.change(secretInput, { target: { value: "key-123" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(defaultProps.onSubmit).toHaveBeenCalledWith({
        label: "Anthropic key",
        secret: "key-123",
      });
    });
  });

  it("shows 'Saving...' while submitting", async () => {
    let resolveSubmit: () => void;
    defaultProps.onSubmit = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      }),
    );

    render(<CredentialModal {...defaultProps} />);
    const secretInput = screen.getByPlaceholderText("Paste your key");
    fireEvent.change(secretInput, { target: { value: "sk-abc" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saving...")).toBeTruthy();
    });

    resolveSubmit!();
  });

  it("disables buttons while submitting", async () => {
    let resolveSubmit: () => void;
    defaultProps.onSubmit = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      }),
    );

    render(<CredentialModal {...defaultProps} />);
    const secretInput = screen.getByPlaceholderText("Paste your key");
    fireEvent.change(secretInput, { target: { value: "sk-abc" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saving...")).toBeDisabled();
      expect(screen.getByText("Cancel")).toBeDisabled();
    });

    resolveSubmit!();
  });

  it("displays error when onSubmit throws", async () => {
    defaultProps.onSubmit = vi.fn().mockRejectedValue(new Error("Save failed"));

    render(<CredentialModal {...defaultProps} />);
    const secretInput = screen.getByPlaceholderText("Paste your key");
    fireEvent.change(secretInput, { target: { value: "sk-abc" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Save failed")).toBeTruthy();
    });
  });

  it("displays fallback error when onSubmit error has no message", async () => {
    defaultProps.onSubmit = vi.fn().mockRejectedValue(new Error(""));

    render(<CredentialModal {...defaultProps} />);
    const secretInput = screen.getByPlaceholderText("Paste your key");
    fireEvent.change(secretInput, { target: { value: "sk-abc" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Failed to save credential.")).toBeTruthy();
    });
  });

  it("calls onCancel when Cancel button is clicked", () => {
    render(<CredentialModal {...defaultProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });

  it("calls onCancel when dialog is closed via overlay", () => {
    render(<CredentialModal {...defaultProps} />);
    fireEvent.click(screen.getByTestId("dialog-overlay"));
    expect(defaultProps.onCancel).toHaveBeenCalled();
  });
});

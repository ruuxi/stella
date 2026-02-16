import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectDialog } from "./ConnectDialog";
import { INTEGRATIONS } from "./integration-configs";

vi.mock("@/components/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) =>
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
  DialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogCloseButton: () => <button type="button">X</button>,
}));

vi.mock("./IntegrationCard", () => ({
  IntegrationGridCard: ({
    integration,
    isSelected,
    onClick,
  }: {
    integration: { provider: string; displayName: string };
    isSelected: boolean;
    onClick: () => void;
  }) => (
    <button
      type="button"
      data-testid={`grid-${integration.provider}`}
      data-selected={isSelected ? "yes" : "no"}
      onClick={onClick}
    >
      {integration.displayName}
    </button>
  ),
  IntegrationDetailArea: ({ integration }: { integration: { provider: string } }) => (
    <div data-testid="detail-area">detail:{integration.provider}</div>
  ),
}));

describe("ConnectDialog", () => {
  it("selects and toggles integration details from grid cards", () => {
    const onOpenChange = vi.fn();
    const provider = INTEGRATIONS[0].provider;

    render(<ConnectDialog open={true} onOpenChange={onOpenChange} />);

    const target = screen.getByTestId(`grid-${provider}`);
    expect(target).toHaveAttribute("data-selected", "no");
    expect(screen.queryByTestId("detail-area")).toBeNull();

    fireEvent.click(target);
    expect(target).toHaveAttribute("data-selected", "yes");
    expect(screen.getByTestId("detail-area")).toHaveTextContent(`detail:${provider}`);

    fireEvent.click(target);
    expect(target).toHaveAttribute("data-selected", "no");
    expect(screen.queryByTestId("detail-area")).toBeNull();
  });

  it("resets selected integration when dialog closes", () => {
    const onOpenChange = vi.fn();
    const provider = INTEGRATIONS[1].provider;

    const { rerender } = render(
      <ConnectDialog open={true} onOpenChange={onOpenChange} />,
    );

    const target = screen.getByTestId(`grid-${provider}`);
    fireEvent.click(target);
    expect(screen.getByTestId("detail-area")).toHaveTextContent(`detail:${provider}`);

    fireEvent.click(screen.getByTestId("dialog-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(<ConnectDialog open={true} onOpenChange={onOpenChange} />);
    expect(screen.queryByTestId("detail-area")).toBeNull();
  });
});

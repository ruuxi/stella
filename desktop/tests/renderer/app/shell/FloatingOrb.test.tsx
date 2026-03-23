import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, forwardRef, type PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingOrb, type FloatingOrbHandle } from "../../../../src/shell/FloatingOrb";

vi.mock("motion/react", () => {
  const MotionDiv = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <div {...props}>{children}</div>
  );
  const MotionForm = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <form {...props}>{children}</form>
  );

  return {
    AnimatePresence: ({ children }: PropsWithChildren) => <>{children}</>,
    motion: {
      div: MotionDiv,
      form: MotionForm,
    },
  };
});

vi.mock("@/app/chat/CompactConversationSurface", () => ({
  CompactConversationSurface: () => <div data-testid="orb-conversation" />,
}));

vi.mock("@/app/chat/hooks/use-file-drop", () => ({
  useFileDrop: () => ({
    isDragOver: false,
    isWindowDragActive: false,
    dropHandlers: {},
  }),
}));

vi.mock("@/app/chat/DropOverlay", () => ({
  DropOverlay: () => null,
}));

vi.mock("@/shell/ascii-creature/StellaAnimation", () => ({
  StellaAnimation: forwardRef((_props: Record<string, unknown>, _ref) => (
    <div data-testid="stella-animation" />
  )),
}));

describe("FloatingOrb", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("shows a window badge for seeded orb context and removes it fully when dismissed", () => {
    const ref = createRef<FloatingOrbHandle>();

    render(
      <FloatingOrb
        ref={ref}
        visible
        events={[]}
        streamingText=""
        reasoningText=""
        isStreaming={false}
        pendingUserMessageId={null}
        selfModMap={{}}
        hasOlderEvents={false}
        isLoadingOlder={false}
        isInitialLoading={false}
        onSend={vi.fn()}
      />,
    );

    act(() => {
      ref.current?.openChat({
        window: {
          app: "Stella",
          title: "Activity Feed",
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        },
        windowText: "Captured in-app context",
      });
    });

    expect(screen.getByText("Activity Feed")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask about this window...")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Remove window context"));

    expect(screen.queryByText("Activity Feed")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask anything")).toBeInTheDocument();
  });
});

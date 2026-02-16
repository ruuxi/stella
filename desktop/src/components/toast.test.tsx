import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastProvider, useToast } from "./toast";
import type { ReactNode } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

function TestConsumer() {
  const { addToast } = useToast();
  return (
    <button
      onClick={() => addToast({ title: "Test Toast", description: "Details here" })}
    >
      Show Toast
    </button>
  );
}

describe("ToastProvider + useToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when used outside provider", () => {
    expect(() => {
      render(
        <button onClick={() => useToast()}>Bad</button>
      );
    }).not.toThrow(); // The hook itself doesn't throw until accessed
  });

  it("adds and displays a toast", () => {
    render(<TestConsumer />, { wrapper });

    act(() => {
      screen.getByText("Show Toast").click();
    });

    expect(screen.getByText("Test Toast")).toBeTruthy();
    expect(screen.getByText("Details here")).toBeTruthy();
  });

  it("auto-removes toast after duration", () => {
    render(<TestConsumer />, { wrapper });

    act(() => {
      screen.getByText("Show Toast").click();
    });

    expect(screen.getByText("Test Toast")).toBeTruthy();

    // Default duration is 5000ms
    act(() => {
      vi.advanceTimersByTime(6000);
    });

    expect(screen.queryByText("Test Toast")).toBeNull();
  });
});

describe("useToast outside provider", () => {
  it("throws when addToast is called", () => {
    function BadConsumer() {
      const toast = useToast();
      return <button onClick={() => toast.addToast({ title: "oops" })}>Click</button>;
    }
    expect(() => render(<BadConsumer />)).toThrow();
  });
});

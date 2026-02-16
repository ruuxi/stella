import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import AppframeRenderer from "./appframe";

/**
 * React 19 stores event handlers in __reactProps$ on the DOM element rather
 * than using addEventListener for certain events like onError on iframes.
 * Standard dispatchEvent/fireEvent does not trigger these handlers in jsdom.
 * We access the React internal props to invoke onError directly.
 */
function getReactProps(el: Element): Record<string, unknown> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  if (!key) throw new Error("Could not find __reactProps$ on element");
  return (el as unknown as Record<string, unknown>)[key] as Record<string, unknown>;
}

function triggerIframeError(iframe: HTMLIFrameElement) {
  const props = getReactProps(iframe);
  if (typeof props.onError !== "function") {
    throw new Error("onError not found in React props");
  }
  act(() => {
    (props.onError as () => void)();
  });
}

describe("AppframeRenderer", () => {
  it("renders 'No URL provided' when canvas.url is undefined", () => {
    render(<AppframeRenderer canvas={{ name: "test-app" }} />);
    expect(screen.getByText("No URL provided")).toBeTruthy();
  });

  it("renders 'No URL provided' when canvas.url is empty string", () => {
    render(<AppframeRenderer canvas={{ name: "test-app", url: "" }} />);
    expect(screen.getByText("No URL provided")).toBeTruthy();
  });

  it("renders iframe with correct src when url is provided", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    const iframe = document.querySelector("iframe");
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute("src")).toBe("http://localhost:5180");
  });

  it("renders toolbar with URL text", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    expect(screen.getByText("http://localhost:5180")).toBeTruthy();
  });

  it("renders reload button in toolbar", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    expect(screen.getByText("Reload")).toBeTruthy();
  });

  it("shows loading indicator initially", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("hides iframe while loading", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.display).toBe("none");
  });

  it("shows iframe and hides loading after onLoad fires", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;

    fireEvent.load(iframe);

    expect(screen.queryByText("Loading...")).toBeNull();
    expect(iframe.style.display).toBe("flex");
  });

  it("shows error message when onError fires", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );

    triggerIframeError(document.querySelector("iframe") as HTMLIFrameElement);

    expect(
      screen.getByText("Failed to load. Is the dev server running?")
    ).toBeTruthy();
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.style.display).toBe("none");
  });

  it("shows retry button on error", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );

    triggerIframeError(document.querySelector("iframe") as HTMLIFrameElement);

    const retryButton = screen.getByText("Retry");
    expect(retryButton).toBeTruthy();
  });

  it("hides loading indicator on error", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );

    expect(screen.getByText("Loading...")).toBeTruthy();

    triggerIframeError(document.querySelector("iframe") as HTMLIFrameElement);

    expect(screen.queryByText("Loading...")).toBeNull();
  });

  it("resets state when reload button is clicked after error", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );

    triggerIframeError(document.querySelector("iframe") as HTMLIFrameElement);
    expect(
      screen.getByText("Failed to load. Is the dev server running?")
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Reload"));

    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(
      screen.queryByText("Failed to load. Is the dev server running?")
    ).toBeNull();
  });

  it("resets state when retry button (in error view) is clicked", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );

    triggerIframeError(document.querySelector("iframe") as HTMLIFrameElement);
    fireEvent.click(screen.getByText("Retry"));

    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("reload resets iframe src", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );

    fireEvent.click(screen.getByText("Reload"));

    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("localhost:5180");
  });

  it("sets sandbox attribute on iframe", () => {
    render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    const iframe = document.querySelector("iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-modals"
    );
  });

  it("applies appframe-wrap class to container", () => {
    const { container } = render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    expect(container.querySelector(".canvas-appframe-wrap")).toBeTruthy();
  });

  it("applies appframe-toolbar class", () => {
    const { container } = render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    expect(
      container.querySelector(".canvas-appframe-toolbar")
    ).toBeTruthy();
  });

  it("applies appframe-url class to url span", () => {
    const { container } = render(
      <AppframeRenderer
        canvas={{ name: "test-app", url: "http://localhost:5180" }}
      />
    );
    expect(container.querySelector(".canvas-appframe-url")).toBeTruthy();
  });
});

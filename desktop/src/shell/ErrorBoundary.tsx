import { Component, type ErrorInfo, type ReactNode } from "react";
import { CrashSurface } from "./CrashSurface";
import { reportRendererError } from "@/platform/diagnostics/report-error";
import {
  STELLA_BUILD_ERROR_CLEARED_EVENT,
  STELLA_BUILD_ERROR_EVENT,
  type StellaBuildErrorDetail,
} from "@/platform/dev/vite-error-recovery";

type Props = { children: ReactNode };
type State = {
  hasError: boolean;
  caughtError: Error | null;
  componentStack: string | null;
  source: "react" | "build";
};

/**
 * React error boundary for crashes that bubble up through normal React
 * rendering (i.e. anything outside a TanStack Router route subtree). Router
 * crashes are intercepted by `defaultErrorComponent` in `router.tsx` before
 * they reach this boundary; both code paths render the same `CrashSurface`.
 *
 * Also listens for Vite dev-server build / parse errors forwarded from
 * `platform/dev/vite-error-recovery.ts` so oxc transform failures surface
 * through the same surface (Reload / Ask Stella to repair / Undo update)
 * instead of Vite's red overlay.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    caughtError: null,
    componentStack: null,
    source: "react",
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, caughtError: error, source: "react" };
  }

  componentDidMount() {
    window.addEventListener(
      STELLA_BUILD_ERROR_EVENT,
      this.handleBuildError as EventListener,
    );
    window.addEventListener(
      STELLA_BUILD_ERROR_CLEARED_EVENT,
      this.handleBuildErrorCleared,
    );
  }

  componentWillUnmount() {
    window.removeEventListener(
      STELLA_BUILD_ERROR_EVENT,
      this.handleBuildError as EventListener,
    );
    window.removeEventListener(
      STELLA_BUILD_ERROR_CLEARED_EVENT,
      this.handleBuildErrorCleared,
    );
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
    reportRendererError({
      kind: "react",
      message: error.message,
      stack: error.stack,
      source: info.componentStack?.trim().split("\n")[0]?.trim(),
    });
    this.setState({
      caughtError: error,
      componentStack: info.componentStack ?? null,
      source: "react",
    });
  }

  private handleBuildError = (event: CustomEvent<StellaBuildErrorDetail>) => {
    const detail = event.detail;
    if (!detail?.error) return;
    console.error("ErrorBoundary received build error:", detail.error);
    this.setState({
      hasError: true,
      caughtError: detail.error,
      componentStack: detail.frame ?? null,
      source: "build",
    });
  };

  private handleBuildErrorCleared = () => {
    if (this.state.source !== "build" || !this.state.hasError) return;
    this.setState({
      hasError: false,
      caughtError: null,
      componentStack: null,
      source: "react",
    });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <CrashSurface
        error={this.state.caughtError}
        componentStack={this.state.componentStack}
      />
    );
  }
}

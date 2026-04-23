import { Component, type ErrorInfo, type ReactNode } from "react";
import { CrashSurface } from "./CrashSurface";

type Props = { children: ReactNode };
type State = {
  hasError: boolean;
  caughtError: Error | null;
  componentStack: string | null;
};

/**
 * React error boundary for crashes that bubble up through normal React
 * rendering (i.e. anything outside a TanStack Router route subtree). Router
 * crashes are intercepted by `defaultErrorComponent` in `router.tsx` before
 * they reach this boundary; both code paths render the same `CrashSurface`.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    caughtError: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, caughtError: error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
    this.setState({
      caughtError: error,
      componentStack: info.componentStack ?? null,
    });
  }

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

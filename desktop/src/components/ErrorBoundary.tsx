import { Component, type ReactNode, type ErrorInfo } from "react";

type Props = { children: ReactNode };
type State = { hasError: boolean; reverting: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, reverting: false };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
  }

  handleRevert = async () => {
    this.setState({ reverting: true });
    try {
      const featureId = await window.electronAPI?.getLastSelfModFeature();
      if (featureId) {
        await window.electronAPI?.selfModRevert(featureId);
      }
      window.location.reload();
    } catch {
      window.location.reload();
    }
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="error-boundary">
        <div className="error-boundary-content">
          <h2>Something went wrong</h2>
          <p>
            An unexpected error occurred. You can try undoing recent changes or
            reloading.
          </p>
          <div className="error-boundary-actions">
            <button
              className="error-boundary-btn error-boundary-btn--primary"
              onClick={this.handleRevert}
              disabled={this.state.reverting}
            >
              {this.state.reverting ? "Reverting..." : "Undo recent changes"}
            </button>
            <button
              className="error-boundary-btn"
              onClick={this.handleReload}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

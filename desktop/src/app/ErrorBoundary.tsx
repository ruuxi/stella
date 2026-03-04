import { Component, type ReactNode, type ErrorInfo } from "react";
import type { SelfModFeatureSummary } from "@/types/electron";

type Props = { children: ReactNode };
type State = {
  hasError: boolean;
  revertingFeatureId: string | null;
  features: SelfModFeatureSummary[];
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    revertingFeatureId: null,
    features: [],
  };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
    void this.loadFeatures();
  }

  loadFeatures = async () => {
    try {
      const features = await window.electronAPI?.agent.listSelfModFeatures(5);
      this.setState({ features: features ?? [] });
    } catch (error) {
      console.error("ErrorBoundary feature load failed:", error);
      this.setState({ features: [] });
    }
  };

  handleRevert = async (featureId?: string) => {
    this.setState({ revertingFeatureId: featureId ?? "__latest__" });
    try {
      await window.electronAPI?.agent.selfModRevert(featureId, 1);
      window.location.reload();
    } catch (err) {
      console.error("ErrorBoundary revert failed:", err);
      this.setState({ revertingFeatureId: null });
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
          {this.state.features.length > 0 && (
            <div className="error-boundary-feature-list">
              {this.state.features.map((feature) => {
                const isReverting = this.state.revertingFeatureId === feature.featureId;
                return (
                  <button
                    key={feature.featureId}
                    className="error-boundary-btn"
                    onClick={() => this.handleRevert(feature.featureId)}
                    disabled={this.state.revertingFeatureId !== null}
                  >
                    {isReverting ? "Reverting..." : `Undo ${feature.name}`}
                  </button>
                );
              })}
            </div>
          )}
          <div className="error-boundary-actions">
            <button
              className="error-boundary-btn error-boundary-btn--primary"
              onClick={() => this.handleRevert()}
              disabled={this.state.revertingFeatureId !== null}
            >
              {this.state.revertingFeatureId === "__latest__" ? "Reverting..." : "Undo latest update"}
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

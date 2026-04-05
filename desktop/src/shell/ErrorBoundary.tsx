import { Component, type ReactNode, type ErrorInfo, type MouseEvent } from "react";
import type { SelfModFeatureSummary } from "@/shared/types/electron";
import { ShiftingGradient } from "./background/ShiftingGradient";
import "./error-boundary.css";

type Props = { children: ReactNode };
type State = {
  hasError: boolean;
  revertingFeatureId: string | null;
  features: SelfModFeatureSummary[];
  repairStatus: "idle" | "running" | "failed";
  repairMessage: string;
  caughtError: Error | null;
  caughtErrorInfo: ErrorInfo | null;
};

const AUTO_REPAIR_SIGNATURE_KEY = "stella:auto-repair:last-signature";

const buildAutoRepairPrompt = (error: Error, componentStack: string) => {
  const stack = componentStack.trim() || "(no component stack)";
  return `A render crash happened in Stella's frontend.

Please perform an automatic self-repair now:
1. Find and fix the root cause in the frontend code.
2. Keep behavior changes minimal and safe.
3. Validate with frontend typecheck/tests when possible.
4. If you make code changes, commit them with a stable [feature:auto-repair] tag.

Crash details:
- Error: ${error.name}: ${error.message}
- Component stack:
${stack}

After fixing, return a concise summary of what you changed.`;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    revertingFeatureId: null,
    features: [],
    repairStatus: "idle",
    repairMessage: "",
    caughtError: null,
    caughtErrorInfo: null,
  };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
    this.setState({ caughtError: error, caughtErrorInfo: info });
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

  handleRepair = async (_e?: MouseEvent) => {
    const { caughtError, caughtErrorInfo, repairStatus } = this.state;
    if (repairStatus === "running" || !caughtError) return;

    const api = window.electronAPI;
    if (!api?.agent?.startChat || !api?.agent?.healthCheck || !api?.ui?.getState) {
      this.setState({
        repairStatus: "failed",
        repairMessage: "Repair is unavailable right now.",
      });
      return;
    }

    const health = await api.agent.healthCheck();
    if (!health?.ready) {
      this.setState({
        repairStatus: "failed",
        repairMessage: "Repair is unavailable right now.",
      });
      return;
    }

    const signature = `${caughtError.name}:${caughtError.message}:${caughtErrorInfo?.componentStack ?? ""}`.slice(0, 12_000);
    const previousSignature = sessionStorage.getItem(AUTO_REPAIR_SIGNATURE_KEY);
    if (previousSignature === signature) {
      this.setState({
        repairStatus: "failed",
        repairMessage: "A repair was already attempted for this crash.",
      });
      return;
    }
    sessionStorage.setItem(AUTO_REPAIR_SIGNATURE_KEY, signature);

    this.setState({
      repairStatus: "running",
      repairMessage: "Stella is fixing this...",
    });

    try {
      const uiState = await api.ui.getState();
      const conversationId =
        typeof uiState?.conversationId === "string" && uiState.conversationId.trim()
          ? uiState.conversationId
          : null;
      if (!conversationId) {
        throw new Error("No active conversation for repair.");
      }

      const prompt = buildAutoRepairPrompt(caughtError, caughtErrorInfo?.componentStack ?? "");

      const { runId } = await api.agent.startChat({
        conversationId,
        userPrompt: prompt,
        agentType: "orchestrator",
        storageMode: "local",
      });

      const unsubscribe = api.agent.onStream((event) => {
        if (event.runId !== runId) return;

        if (event.type === "end") {
          unsubscribe();
          window.location.reload();
          return;
        }

        if (event.type === "error" && event.fatal) {
          unsubscribe();
          this.setState({
            repairStatus: "failed",
            repairMessage: "Repair could not complete. You can undo recent updates below.",
          });
        }
      });
    } catch (repairError) {
      console.error("ErrorBoundary repair failed:", repairError);
      this.setState({
        repairStatus: "failed",
        repairMessage: "Repair could not start. You can undo recent updates below.",
      });
    }
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="error-boundary">
        <ShiftingGradient className="error-boundary-gradient" />
        <div className="error-boundary-content">
          <h2>Something went wrong</h2>
          <p>
            An unexpected error occurred. You can try undoing recent changes or
            reloading.
          </p>
          {this.state.repairStatus !== "idle" && (
            <p className="error-boundary-status">
              {this.state.repairMessage}
            </p>
          )}
          <div className="error-boundary-actions">
            {this.state.repairStatus === "idle" && this.state.caughtError && (
              <button
                className="error-boundary-btn error-boundary-btn--fix"
                onClick={this.handleRepair}
              >
                Ask Stella to fix
              </button>
            )}
            <button
              className="error-boundary-btn"
              onClick={() => this.handleRevert()}
              disabled={this.state.revertingFeatureId !== null}
            >
              {this.state.revertingFeatureId ? "Reverting..." : "Undo"}
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

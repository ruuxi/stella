import type { BootstrapState } from "./context.js";
import type {
  PiRunnerTarget,
  StellaRootTarget,
  StellaHostRunnerTarget,
  WindowManagerTarget,
} from "../../runtime/kernel/lifecycle-targets.js";

export class BootstrapLifecycleBindings
  implements
    WindowManagerTarget,
    StellaRootTarget,
    StellaHostRunnerTarget,
    PiRunnerTarget
{
  private readonly runnerListeners = new Set<
    (runner: BootstrapState["stellaHostRunner"]) => void
  >();

  constructor(private readonly state: BootstrapState) {}

  readonly getWindowManager = () => this.state.windowManager;

  readonly setWindowManager = (windowManager: BootstrapState["windowManager"]) => {
    this.state.windowManager = windowManager;
  };

  readonly getStellaRoot = () => this.state.stellaRoot;

  readonly setStellaRoot = (stellaRoot: string | null) => {
    this.state.stellaRoot = stellaRoot;
  };

  readonly getRunner = () => this.state.stellaHostRunner;

  readonly setRunner = (runner: BootstrapState["stellaHostRunner"]) => {
    this.state.stellaHostRunner = runner;
    for (const listener of this.runnerListeners) {
      listener(runner);
    }
  };

  readonly onRunnerChanged = (
    listener: (runner: BootstrapState["stellaHostRunner"]) => void,
  ) => {
    this.runnerListeners.add(listener);
    return () => {
      this.runnerListeners.delete(listener);
    };
  };
}

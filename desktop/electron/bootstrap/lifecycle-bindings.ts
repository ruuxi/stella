import type { BootstrapState } from "./context.js";
import type {
  PiRunnerTarget,
  StellaHomePathTarget,
  StellaHostRunnerTarget,
  WindowManagerTarget,
} from "../services/lifecycle-targets.js";

export class BootstrapLifecycleBindings
  implements
    WindowManagerTarget,
    StellaHomePathTarget,
    StellaHostRunnerTarget,
    PiRunnerTarget
{
  constructor(private readonly state: BootstrapState) {}

  readonly getWindowManager = () => this.state.windowManager;

  readonly setWindowManager = (windowManager: BootstrapState["windowManager"]) => {
    this.state.windowManager = windowManager;
  };

  readonly getStellaHomePath = () => this.state.stellaHomePath;

  readonly setStellaHomePath = (stellaHomePath: string | null) => {
    this.state.stellaHomePath = stellaHomePath;
  };

  readonly getRunner = () => this.state.stellaHostRunner;

  readonly setRunner = (runner: BootstrapState["stellaHostRunner"]) => {
    this.state.stellaHostRunner = runner;
  };
}

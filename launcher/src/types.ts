export type SetupStepId =
  | "runtime"
  | "prepare"
  | "parakeet"
  | "payload"
  | "nativehelpers"
  | "deps"
  | "env"
  | "browser"
  | "shortcuts"
  | "finalize";

export type SetupStepStatus =
  | "pending"
  | "checking"
  | "installing"
  | "done"
  | "skipped"
  | "error";

export type SetupStep = {
  id: SetupStepId;
  label: string;
  status: SetupStepStatus;
  detail?: string;
  progress?: number;
};

export type InstallerPhase =
  | "checking"
  | "ready"
  | "installing"
  | "updating"
  | "complete"
  | "error";

export type LauncherUpdateInfo = {
  available: boolean;
  version?: string;
  checking: boolean;
  installing: boolean;
  lastCheckedAtMs: number;
  error?: string;
};

export type InstallerState = {
  steps: SetupStep[];
  phase: InstallerPhase;
  errorMessage?: string;
  warningMessage?: string;
  installPath: string;
  defaultInstallPath: string;
  devMode: boolean;
  installPathLocked: boolean;
  installPathError?: string;
  runAfterInstall: boolean;
  canLaunch: boolean;
  installed: boolean;
  launcherUpdate: LauncherUpdateInfo;
  disk: {
    requiredBytes: number;
    availableBytes: number | null;
    usedBytes: number;
    enoughSpace: boolean;
  };
};

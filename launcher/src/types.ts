export type SetupStepId =
  | "runtime"
  | "prepare"
  | "payload"
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
};

export type InstallerPhase =
  | "checking"
  | "ready"
  | "installing"
  | "complete"
  | "error";

export type InstallerState = {
  steps: SetupStep[];
  phase: InstallerPhase;
  errorMessage?: string;
  warningMessage?: string;
  installPath: string;
  defaultInstallPath: string;
  installPathError?: string;
  runAfterInstall: boolean;
  canLaunch: boolean;
  installed: boolean;
  disk: {
    requiredBytes: number;
    availableBytes: number | null;
    usedBytes: number;
    enoughSpace: boolean;
  };
};

export type ThirdPartyMigrationSource = "hermes" | "openclaw";

export type ThirdPartyMigrationOption =
  | "memory"
  | "user"
  | "sessionHistory"
  | "skills"
  | "personality"
  | "modelConfig"
  | "schedules";

export type ThirdPartyMigrationSelection = Partial<
  Record<ThirdPartyMigrationOption, boolean>
>;

export type ThirdPartyMigrationFinding = {
  option: ThirdPartyMigrationOption;
  label: string;
  found: boolean;
  count: number;
  paths: string[];
  note?: string;
};

export type ThirdPartyMigrationPreview = {
  source: ThirdPartyMigrationSource;
  sourceRoot: string;
  displayName: string;
  found: boolean;
  findings: ThirdPartyMigrationFinding[];
};

export type ThirdPartyMigrationReportItem = {
  kind: ThirdPartyMigrationOption | "channels" | "source" | "report";
  status: "imported" | "skipped" | "manual" | "error";
  source?: string;
  target?: string;
  message: string;
  count?: number;
};

export type ThirdPartyMigrationReport = {
  source: ThirdPartyMigrationSource;
  sourceRoot: string;
  stellaHome: string;
  startedAt: string;
  completedAt: string;
  markdownPath: string;
  items: ThirdPartyMigrationReportItem[];
};

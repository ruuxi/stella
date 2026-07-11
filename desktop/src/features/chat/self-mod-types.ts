export type SelfModApplied = {
  commitHash: string;
  changeSetId?: string;
  runId?: string;
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied";
};

export type SelfModApplied = {
  commitHash: string;
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied";
};

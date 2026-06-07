export type SelfModApplied = {
  featureId: string;
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied";
};

export type SelfModApplied = {
  /**
   * Stable identity of the exact grouped change set applied by this card.
   */
  applyId?: string;
  changeSetId?: string;
  /** Set once the run's commit lands. Undo stays hidden until it is present. */
  commitHash?: string;
  /** All commits represented by a grouped card, in finalize order. */
  commitHashes?: string[];
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied" | "reverted";
};

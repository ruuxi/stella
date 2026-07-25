export type SelfModApplied = {
  /**
   * Stable card identity — the self-mod run id. Present on cards written since
   * the card was decoupled from commit timing; older persisted rows carry only
   * `commitHash`, so treat either as the id when acting on a card.
   */
  applyId?: string;
  /** Set once the run's commit lands. Undo stays hidden until it is present. */
  commitHash?: string;
  files: string[];
  batchIndex: number;
  status?: "pending" | "applied";
};

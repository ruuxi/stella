/**
 * Shared async utilities.
 */

/** Promise-based delay. */
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

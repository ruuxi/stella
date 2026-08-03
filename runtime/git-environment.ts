/**
 * Resolve the Git executable selected by the Stella launcher.
 *
 * Packaged launches receive an absolute `STELLA_GIT_BIN`; development and
 * source runs fall back to the user's Git on PATH. The launcher also injects
 * any managed-runtime variables Git needs, so runtime callers do not need a
 * package-specific environment rewriter.
 */
export const setupGitEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; gitLocation: string } => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  const gitLocation = env.STELLA_GIT_BIN?.trim() || "git";
  return { env, gitLocation };
};

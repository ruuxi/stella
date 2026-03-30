import { existsSync } from "fs";
import path from "path";

/**
 * Resolve the bundled Google Workspace MCP server entry (`workspace-server/dist/index.js`).
 * Override with `STELLA_GOOGLE_WORKSPACE_MCP_PATH` for custom installs.
 */
export const resolveGoogleWorkspaceMcpEntry = (
  frontendRoot?: string,
): string | null => {
  const envPath = process.env.STELLA_GOOGLE_WORKSPACE_MCP_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const resourcesRoot = process.env.STELLA_APP_RESOURCES_PATH?.trim();

  const candidates: string[] = [];

  if (resourcesRoot) {
    candidates.push(
      path.join(
        resourcesRoot,
        "google-workspace-mcp",
        "workspace-server",
        "dist",
        "index.js",
      ),
    );
  }

  if (frontendRoot) {
    candidates.push(
      path.join(
        frontendRoot,
        "resources",
        "google-workspace-mcp",
        "workspace-server",
        "dist",
        "index.js",
      ),
      path.join(
        frontendRoot,
        "google-workspace-mcp",
        "workspace-server",
        "dist",
        "index.js",
      ),
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

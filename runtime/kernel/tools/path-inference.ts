import path from "node:path";
import type { ToolContext } from "./types.js";
import { expandHomePath } from "./utils.js";

const SHELL_TOKEN_PATTERN = /"([^"]+)"|'([^']+)'|([^\s;&|<>]+)/g;
const EMBEDDED_PATH_PATTERN =
  /(?:~(?:[\\/][^\s"';&|<>),]*)?|\.{1,2}[\\/][^\s"';&|<>),]*|\/[^\s"';&|<>),]*|[A-Za-z]:[\\/][^\s"';&|<>),]*)/g;

export const resolveToolPath = (
  rawPath: unknown,
  args: Record<string, unknown>,
  context?: Pick<ToolContext, "stellaRoot">,
): string | null => {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return null;
  const expanded = expandHomePath(rawPath.trim());
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  const rawWorkdir = args.workdir ?? args.working_directory ?? args.cwd;
  const base =
    typeof rawWorkdir === "string" && rawWorkdir.trim().length > 0
      ? path.resolve(expandHomePath(rawWorkdir.trim()))
      : (context?.stellaRoot ?? process.cwd());
  return path.resolve(base, expanded);
};

export const inferShellMentionedPaths = (
  args: Record<string, unknown>,
  context?: Pick<ToolContext, "stellaRoot">,
): string[] => {
  const command =
    typeof args.cmd === "string"
      ? args.cmd
      : typeof args.command === "string"
        ? args.command
        : "";
  if (!command.trim()) return [];

  const out: string[] = [];
  const consider = (rawPath: string) => {
    const resolved = resolveToolPath(rawPath, args, context);
    if (resolved) out.push(resolved);
  };
  for (const match of command.matchAll(SHELL_TOKEN_PATTERN)) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    if (!token || token.startsWith("-")) continue;
    if (
      path.isAbsolute(token) ||
      token.startsWith("~/") ||
      token === "~" ||
      token.startsWith("./") ||
      token.startsWith("../") ||
      token.startsWith("desktop/") ||
      token.startsWith("runtime/") ||
      token.startsWith("backend/") ||
      token.startsWith("launcher/")
    ) {
      consider(token);
      continue;
    }
    for (const embedded of token.matchAll(EMBEDDED_PATH_PATTERN)) {
      const rawPath = embedded[0];
      if (rawPath && rawPath !== "/") {
        consider(rawPath);
      }
    }
  }
  return [...new Set(out)];
};

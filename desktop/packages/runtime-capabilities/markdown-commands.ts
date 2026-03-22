import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { CapabilityCommandDefinition } from "./types.js";

const parseFrontmatter = (content: string, filePath: string) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: content.trim() };
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = YAML.parse(match[1]) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid command frontmatter in ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    frontmatter,
    body: content.slice(match[0].length).trim(),
  };
};

const normalizeCommandId = (root: string, filePath: string) =>
  path
    .relative(root, filePath)
    .replace(/\\/g, "/")
    .replace(/\.md$/i, "")
    .replace(/\//g, ".");

const visitMarkdownFiles = async (root: string): Promise<string[]> => {
  let entries: Array<import("node:fs").Dirent> = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await visitMarkdownFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
};

export const loadMarkdownCommands = async (roots: string[]) => {
  const commands: CapabilityCommandDefinition[] = [];

  for (const root of roots) {
    const files = await visitMarkdownFiles(root);
    for (const filePath of files) {
      try {
        const raw = await fs.readFile(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter(raw, filePath);
        const description =
          typeof frontmatter.description === "string"
            ? frontmatter.description
            : `Command loaded from ${path.basename(filePath)}`;
        const argumentHint =
          typeof frontmatter["argument-hint"] === "string"
            ? frontmatter["argument-hint"]
            : undefined;
        commands.push({
          id: normalizeCommandId(root, filePath),
          description,
          argumentHint,
          sourcePath: filePath,
          async execute(context) {
            const renderedArgs =
              context.argv.length > 0 ? `\n\nArguments:\n${context.argv.join(" ")}` : "";
            return {
              exitCode: 0,
              stdout: `${body}${renderedArgs}`.trim(),
            };
          },
        });
      } catch (error) {
        console.error(
          `[runtime-capabilities] Skipping markdown command "${filePath}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return commands;
};

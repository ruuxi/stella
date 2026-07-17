import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAssistantUpdates } from "@/shell/AgentAssistantUpdates";

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });

describe("agent-authored Activity updates", () => {
  it("has no progress-summary scheduler or request in the client source", () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../../../src");
    const source = sourceFiles(sourceRoot)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toContain("progress_summary");
    expect(source).not.toContain("useAgentProgressSummaryEngine");
    expect(source).not.toContain("publishReasoningSummaries");
  });

  it("renders the agent's own messages verbatim, newest first", () => {
    const older = "I checked the exact route.\nNo rewrite was needed.";
    const newer = "The focused tests now pass — 12/12.";
    const markup = renderToStaticMarkup(
      <AgentAssistantUpdates messages={[older, newer]} max={2} />,
    );

    expect(markup).toContain(older);
    expect(markup).toContain(newer);
    expect(markup.indexOf(newer)).toBeLessThan(markup.indexOf(older));
    expect(markup).toContain('aria-label="Recent agent messages"');
  });
});

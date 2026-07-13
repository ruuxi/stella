import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TaskItem } from "@/features/chat/lib/event-transforms";
import { TaskRow } from "@/shell/LeftSidebarSections";
import { CompletedActivityTaskRow } from "@/shell/display/ActivityHistoryDialog";

const cleanupDiagnostic =
  "Resource cleanup is still pending; client updates remain paused.";

const task: TaskItem = {
  id: "thread-cleanup",
  description: "Update Stella runtime",
  agentType: "general",
  status: "completed",
  startedAtMs: 1,
  completedAtMs: 2,
  lastUpdatedAtMs: 2,
  outputPreview: cleanupDiagnostic,
};

describe("Activity cleanup diagnostics", () => {
  it("renders the persisted diagnostic in the sidebar task row", () => {
    const html = renderToStaticMarkup(
      <TaskRow
        task={task}
        expanded={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        files={[]}
        onOpenFile={vi.fn()}
        orderIndex={0}
      />,
    );

    expect(html).toContain(cleanupDiagnostic);
    expect(html).toContain("chat-workspace-strip__task-output-preview");
  });

  it("renders the persisted diagnostic in the completed-history row", () => {
    const html = renderToStaticMarkup(
      <CompletedActivityTaskRow task={task} onSelectTask={vi.fn()} />,
    );

    expect(html).toContain(cleanupDiagnostic);
    expect(html).toContain("activity-history-dialog__row-output-preview");
    expect(html.indexOf(cleanupDiagnostic)).toBeLessThan(html.indexOf("Done"));
  });
});

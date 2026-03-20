import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { WorkspaceProvider, useWorkspace } from "../../../src/context/workspace-state";

const wrapper = ({ children }: { children: ReactNode }) => (
  <WorkspaceProvider>{children}</WorkspaceProvider>
);

describe("WorkspaceProvider + useWorkspace", () => {
  it("opens and closes a workspace panel", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });

    act(() => {
      result.current.openPanel({
        kind: "dev-project",
        name: "dev-project:stella-site",
        title: "Stella Site",
        projectId: "project-1",
      });
    });

    expect(result.current.state.activePanel).toEqual({
      kind: "dev-project",
      name: "dev-project:stella-site",
      title: "Stella Site",
      projectId: "project-1",
    });

    act(() => {
      result.current.closePanel();
    });

    expect(result.current.state.activePanel).toBeNull();
  });
});

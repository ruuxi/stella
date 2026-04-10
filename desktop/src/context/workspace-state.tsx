import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

type WorkspacePanelBase = {
  name: string;
  title: string;
};

export type DevProjectWorkspacePanel = WorkspacePanelBase & {
  kind: "dev-project";
  projectId: string;
};

export type WorkspacePanel = DevProjectWorkspacePanel;

export type WorkspaceState = {
  activePanel: WorkspacePanel | null;
};

type WorkspaceContextValue = {
  state: WorkspaceState;
  openPanel: (panel: WorkspacePanel) => void;
  closePanel: () => void;
};

const defaultState: WorkspaceState = {
  activePanel: null,
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const WorkspaceProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<WorkspaceState>(defaultState);

  const openPanel = useCallback((panel: WorkspacePanel) => {
    setState((prev) => ({ ...prev, activePanel: panel }));
  }, []);

  const closePanel = useCallback(() => {
    setState((prev) => ({ ...prev, activePanel: null }));
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      state,
      openPanel,
      closePanel,
    }),
    [state, openPanel, closePanel],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useWorkspace = () => {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return context;
};

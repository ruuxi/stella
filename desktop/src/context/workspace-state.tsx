import { HOME_DESIGN_PAGE } from "@/app/registry";
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

export type GeneratedPageWorkspacePanel = WorkspacePanelBase & {
  kind: "generated-page";
  pageId: string;
};

export type WorkspacePanel =
  | DevProjectWorkspacePanel
  | GeneratedPageWorkspacePanel;

export type WorkspaceState = {
  activePanel: WorkspacePanel | null;
  chatWidth: number;
  isChatOpen: boolean;
};

type WorkspaceContextValue = {
  state: WorkspaceState;
  openPanel: (panel: WorkspacePanel) => void;
  closePanel: () => void;
  setChatWidth: (width: number) => void;
  setChatOpen: (open: boolean) => void;
};

const DEFAULT_CHAT_WIDTH = 480;
const MIN_CHAT_WIDTH = 320;
const MAX_CHAT_WIDTH_RATIO = 0.5; // Never exceed 50% of viewport

const defaultState: WorkspaceState = {
  activePanel: {
    kind: "generated-page",
    name: HOME_DESIGN_PAGE.id,
    title: HOME_DESIGN_PAGE.title,
    pageId: HOME_DESIGN_PAGE.id,
  },
  chatWidth: DEFAULT_CHAT_WIDTH,
  isChatOpen: true,
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

  const setChatWidth = useCallback((width: number) => {
    const maxWidth = window.innerWidth * MAX_CHAT_WIDTH_RATIO;
    setState((prev) => ({
      ...prev,
      chatWidth: Math.max(MIN_CHAT_WIDTH, Math.min(width, maxWidth)),
    }));
  }, []);

  const setChatOpen = useCallback((open: boolean) => {
    setState((prev) => ({ ...prev, isChatOpen: open }));
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      state,
      openPanel,
      closePanel,
      setChatWidth,
      setChatOpen,
    }),
    [state, openPanel, closePanel, setChatWidth, setChatOpen],
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

export { MIN_CHAT_WIDTH, MAX_CHAT_WIDTH_RATIO, DEFAULT_CHAT_WIDTH };

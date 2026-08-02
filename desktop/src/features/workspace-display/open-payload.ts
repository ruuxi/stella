import type { DisplayTabPayload } from "@/shared/contracts/display-payload";
import { isFilesPayload } from "./payload-kind";
import { sidebarSections } from "./sidebar-sections";
import { displayTabs } from "./tab-store";
import {
  pushAndOpenSourceDiffBatch,
  type SourceDiffBatch,
} from "./source-diff-batches";
import type { DisplayTabSpec, OpenTabOptions } from "./types";

type WorkspaceDisplayPayloadAdapter = {
  payloadToTabSpec: (payload: DisplayTabPayload) => DisplayTabSpec;
  createSourceDiffTabSpec: () => DisplayTabSpec;
  createAgentThreadTabSpec: (args: AgentThreadTabArgs) => DisplayTabSpec;
};

export type AgentThreadTabArgs = {
  threadId: string;
  conversationId: string;
  agentType: string;
  title: string;
  /** Passive Claude children reuse the thread viewer but never acquire
   * Stella lifecycle controls. Omitted callers are Stella-managed threads. */
  source?: "stella" | "claude-native";
  readOnly?: boolean;
  parentAgentId?: string;
};

let adapter: WorkspaceDisplayPayloadAdapter | null = null;

export const registerWorkspaceDisplayPayloadAdapter = (
  nextAdapter: WorkspaceDisplayPayloadAdapter,
): void => {
  adapter = nextAdapter;
};

const getAdapter = (): WorkspaceDisplayPayloadAdapter => {
  if (!adapter) {
    throw new Error(
      "Workspace display payload adapter has not been registered.",
    );
  }
  return adapter;
};

/**
 * App-facing facade for payload-backed workspace tabs. The shell owns the
 * actual tab bodies; callers outside shell should only ask for a payload to
 * open.
 *
 * Mapping the payload already indexes the artifact and tells Files which file
 * it would show; what an *open* adds on top is pointing the panel at the Files
 * section. A passive registration (`activate: false`) deliberately stops short
 * of that, so a background refresh never steals the user's place.
 */
export const openDisplayPayloadTab = (
  payload: DisplayTabPayload,
  opts?: OpenTabOptions,
): void => {
  const spec = getAdapter().payloadToTabSpec(payload);
  displayTabs.openTab(spec, opts);
  if (isFilesPayload(payload) && (opts?.activate ?? true)) {
    sidebarSections.openLocation("files", spec.id);
  }
};

/**
 * A read-only agent thread is a Work-section drill-down. Opening one registers
 * the viewer and opens the resizable right sidebar on that exact thread.
 * Every entry point relies on this: Activity rows, Work rows, and the inline
 * agent cards in the transcript.
 */
export const openAgentThreadTab = (args: AgentThreadTabArgs): void => {
  const spec = getAdapter().createAgentThreadTabSpec(args);
  displayTabs.openTab(spec);
  sidebarSections.openLocation("files", spec.id);
};

export const openSourceDiffBatch = (batch: SourceDiffBatch): void => {
  pushAndOpenSourceDiffBatch(batch, getAdapter().createSourceDiffTabSpec());
};

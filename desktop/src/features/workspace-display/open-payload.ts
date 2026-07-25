import type { DisplayTabPayload } from "@/shared/contracts/display-payload";
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
 */
export const openDisplayPayloadTab = (
  payload: DisplayTabPayload,
  opts?: OpenTabOptions,
): void => {
  displayTabs.openTab(getAdapter().payloadToTabSpec(payload), opts);
};

/**
 * A read-only agent thread is the Tasks section's drill-down, so opening one
 * points that section at it as well as registering the viewer. Registering
 * alone leaves the panel on whatever section was last active and never shows
 * the thread. Every entry point relies on this: the activity rows, and the
 * subagent cards inline in the transcript.
 */
export const openAgentThreadTab = (args: AgentThreadTabArgs): void => {
  const spec = getAdapter().createAgentThreadTabSpec(args);
  displayTabs.openTab(spec);
  sidebarSections.openLocation("tasks", spec.id);
};

export const openSourceDiffBatch = (batch: SourceDiffBatch): void => {
  pushAndOpenSourceDiffBatch(batch, getAdapter().createSourceDiffTabSpec());
};

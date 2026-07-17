import type { DisplayTabPayload } from "@/shared/contracts/display-payload";
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

export const openAgentThreadTab = (args: AgentThreadTabArgs): void => {
  displayTabs.openTab(getAdapter().createAgentThreadTabSpec(args));
};

export const openSourceDiffBatch = (batch: SourceDiffBatch): void => {
  pushAndOpenSourceDiffBatch(batch, getAdapter().createSourceDiffTabSpec());
};

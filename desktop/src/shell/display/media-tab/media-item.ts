/**
 * The item shape the workspace panel's Media tab renders. Items come
 * from the display payload stream — the tab is a viewer over whatever
 * media the agents (or a local import) produced, and does not create
 * media itself.
 */
import type { DisplayPayload } from "@/shared/contracts/display-payload";

export type MediaTabItem = {
  id: string;
  asset: Extract<DisplayPayload, { kind: "media" }>["asset"];
  prompt?: string;
  capability?: string;
  createdAt: number;
};

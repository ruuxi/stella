export type StoreThreadMessage = {
  _id: string;
  role: "user" | "assistant" | "system_event";
  text: string;
  isBlueprint?: boolean;
  denied?: boolean;
  published?: boolean;
  publishedReleaseNumber?: number;
  pending?: boolean;
  attachedFeatureNames?: string[];
  editingBlueprint?: boolean;
};

export type StoreThreadResult = {
  threadId: string | null;
  messages: StoreThreadMessage[];
};

export type StoreCategory =
  | "apps-games"
  | "productivity"
  | "customization"
  | "skills-agents"
  | "integrations"
  | "other";

export const EDIT_BLUEPRINT_PROMPT = "What do you want to change?";
export const EMPTY_STORE_THREAD_MESSAGES: StoreThreadMessage[] = [];

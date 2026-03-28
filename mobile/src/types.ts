export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  /** Present when the user attached images (text may be a short label like "Photo"). */
  hasImage?: boolean;
};

export type DesktopBridgeStatus = {
  available: boolean;
  baseUrls: string[];
  platform: string | null;
  updatedAt: number | null;
};

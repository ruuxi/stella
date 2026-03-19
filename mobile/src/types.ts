export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

export type DesktopBridgeStatus = {
  available: boolean;
  baseUrls: string[];
  platform: string | null;
  updatedAt: number | null;
};

export type MediaServiceTransport =
  | "fal_queue"
  | "stella_chat"
  | "music_api_key";

export type MediaServiceCategory =
  | "audio"
  | "image"
  | "video"
  | "3d"
  | "llm";

export type MediaServiceDefinition = {
  id: string;
  name: string;
  description: string;
  category: MediaServiceCategory;
  transport: MediaServiceTransport;
  docsUrl?: string;
  inputModes: string[];
  outputModes: string[];
  async: boolean;
  llmVariants?: string[];
  hiddenUpstreamId?: string;
};

export type MediaDocsService = Omit<MediaServiceDefinition, "hiddenUpstreamId">;

export type MediaJobTicketPayload = {
  ownerId: string;
  serviceId: string;
  transport: "fal_queue";
  requestId: string;
  endpointId: string;
  issuedAt: number;
};

import type { MediaServiceDefinition } from "./media_sdk_types";

const FAL_QUEUE_BASE_URL =
  process.env.FAL_QUEUE_BASE_URL?.trim() || "https://queue.fal.run";

type FalSubmitOptions = {
  logs?: boolean;
  webhookUrl?: string;
};

const getFalHeaders = (): Record<string, string> => {
  const apiKey = process.env.FAL_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing FAL_KEY environment variable");
  }
  return {
    Authorization: `Key ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
};

const buildFalStatusUrl = (
  endpointId: string,
  requestId: string,
  logs = true,
): string => {
  const url = new URL(
    `${FAL_QUEUE_BASE_URL}/${endpointId}/requests/${requestId}/status`,
  );
  if (logs) {
    url.searchParams.set("logs", "1");
  }
  return url.toString();
};

const buildFalResultUrl = (endpointId: string, requestId: string): string =>
  `${FAL_QUEUE_BASE_URL}/${endpointId}/requests/${requestId}`;

const parseFalJson = async (
  response: Response,
): Promise<Record<string, unknown> | null> => {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const submitFalJob = async (args: {
  service: MediaServiceDefinition;
  input: Record<string, unknown>;
  options: FalSubmitOptions;
}): Promise<Record<string, unknown>> => {
  const endpointId = args.service.hiddenUpstreamId;
  if (!endpointId) {
    throw new Error(`Service ${args.service.id} is missing a fal endpoint mapping`);
  }

  const url = new URL(`${FAL_QUEUE_BASE_URL}/${endpointId}`);
  if (args.options.webhookUrl) {
    url.searchParams.set("fal_webhook", args.options.webhookUrl);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: getFalHeaders(),
    body: JSON.stringify(args.input),
  });

  const json = await parseFalJson(response);
  if (!response.ok || !json) {
    throw new Error(
      `fal submit failed for ${args.service.id}: ${response.status}`,
    );
  }

  const requestId = json.request_id;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    throw new Error(`fal submit response missing request_id for ${args.service.id}`);
  }

  return {
    requestId,
    responseUrl:
      typeof json.response_url === "string"
        ? json.response_url
        : buildFalResultUrl(endpointId, requestId),
    statusUrl:
      typeof json.status_url === "string"
        ? json.status_url
        : buildFalStatusUrl(endpointId, requestId, args.options.logs ?? true),
    cancelUrl:
      typeof json.cancel_url === "string"
        ? json.cancel_url
        : `${FAL_QUEUE_BASE_URL}/${endpointId}/requests/${requestId}/cancel`,
  };
};

export const getFalJobStatus = async (args: {
  endpointId: string;
  requestId: string;
  logs?: boolean;
}): Promise<Record<string, unknown>> => {
  const response = await fetch(
    buildFalStatusUrl(args.endpointId, args.requestId, args.logs ?? true),
    {
      headers: getFalHeaders(),
    },
  );
  const json = await parseFalJson(response);
  if (!response.ok || !json) {
    throw new Error(`fal status failed: ${response.status}`);
  }
  return json;
};

export const getFalJobResult = async (args: {
  endpointId: string;
  requestId: string;
}): Promise<Record<string, unknown>> => {
  const response = await fetch(
    `${buildFalResultUrl(args.endpointId, args.requestId)}/response`,
    {
      headers: getFalHeaders(),
    },
  );
  const json = await parseFalJson(response);
  if (!response.ok || !json) {
    throw new Error(`fal result failed: ${response.status}`);
  }
  return json;
};

export const cancelFalJob = async (args: {
  endpointId: string;
  requestId: string;
}): Promise<Record<string, unknown>> => {
  const response = await fetch(
    `${buildFalResultUrl(args.endpointId, args.requestId)}/cancel`,
    {
      method: "POST",
      headers: getFalHeaders(),
    },
  );
  const json = await parseFalJson(response);
  if (!response.ok || !json) {
    throw new Error(`fal cancel failed: ${response.status}`);
  }
  return json;
};

import { getAuthHeaders } from "@/global/auth/services/auth-token";
import { getOrCreateDeviceId } from "@/platform/electron/device";
import { readConfiguredConvexSiteUrl } from "@/shared/lib/convex-urls";

type ServiceRequest = {
  endpoint: string;
  headers: Record<string, string>;
};

type ServiceRequestOptions = {
  includeAuth?: boolean;
  includeDeviceId?: boolean;
};

type PostServiceJsonOptions = ServiceRequestOptions & {
  headers?: Record<string, string>;
  errorMessage?: (response: Response) => Promise<string> | string;
  onResponse?: (response: Response) => void;
  parseResponse?: boolean;
};

const resolveCloudBaseUrl = (): string => {
  const resolved = readConfiguredConvexSiteUrl(
    import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  );
  if (!resolved) {
    throw new Error("VITE_CONVEX_SITE_URL is not set.");
  }

  const parsed = new URL(resolved);
  const host = parsed.hostname.toLowerCase();
  const isLocalHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1";
  if (!isLocalHost && parsed.protocol !== "https:") {
    throw new Error("Service base URL must use HTTPS outside local development.");
  }

  return resolved;
};

const normalizeServicePath = (path: string): string =>
  path.startsWith("/") ? path : `/${path}`;

export const resolveServiceEndpoint = (path: string): string =>
  new URL(normalizeServicePath(path), resolveCloudBaseUrl()).toString();

export const createServiceRequest = async (
  path: string,
  headers: Record<string, string> = {},
  options: ServiceRequestOptions = {},
): Promise<ServiceRequest> => {
  const endpoint = resolveServiceEndpoint(path);
  const includeAuth = options.includeAuth ?? true;
  const includeDeviceId = options.includeDeviceId ?? true;

  // Run auth + device ID fetch in parallel
  const [requestHeaders, deviceId] = await Promise.all([
    includeAuth ? getAuthHeaders(headers) : Promise.resolve({ ...headers }),
    includeDeviceId
      ? getOrCreateDeviceId().catch(() => null)
      : Promise.resolve(null),
  ]);

  if (deviceId && !requestHeaders["X-Device-ID"]) {
    requestHeaders["X-Device-ID"] = deviceId;
  }

  return {
    endpoint,
    headers: requestHeaders,
  };
};

const defaultServiceErrorMessage = async (response: Response): Promise<string> => {
  const detail = await response.text().catch(() => "");
  return `Service request failed: ${response.status}${detail ? ` ${detail}` : ""}`;
};

export const postServiceJson = async <TResponse>(
  path: string,
  body: unknown,
  options: PostServiceJsonOptions = {},
): Promise<TResponse> => {
  const {
    headers = {},
    errorMessage,
    onResponse,
    parseResponse = true,
    ...requestOptions
  } = options;
  const { endpoint, headers: requestHeaders } = await createServiceRequest(
    path,
    {
      ...headers,
      "Content-Type": "application/json",
    },
    requestOptions,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
  onResponse?.(response);
  if (!response.ok) {
    throw new Error(
      errorMessage
        ? await errorMessage(response)
        : await defaultServiceErrorMessage(response),
    );
  }
  if (!parseResponse) {
    return undefined as TResponse;
  }
  return (await response.json()) as TResponse;
};

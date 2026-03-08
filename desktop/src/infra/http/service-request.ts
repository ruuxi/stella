import { getAuthHeaders } from "@/app/auth/services/auth-token";
import { getOrCreateDeviceId } from "@/platform/electron/device";

type ServiceRequest = {
  endpoint: string;
  headers: Record<string, string>;
};

type ServiceRequestOptions = {
  includeAuth?: boolean;
  includeDeviceId?: boolean;
};

const resolveCloudBaseUrl = (): string => {
  const baseUrl = import.meta.env.VITE_CONVEX_URL;
  if (!baseUrl) {
    throw new Error("VITE_CONVEX_URL is not set.");
  }
  const resolved =
    import.meta.env.VITE_CONVEX_HTTP_URL ??
    baseUrl.replace(".convex.cloud", ".convex.site");

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

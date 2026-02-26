import { getAuthHeaders } from "../auth-token";
import { getOrCreateDeviceId } from "../device";

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
  return (
    import.meta.env.VITE_CONVEX_HTTP_URL ??
    baseUrl.replace(".convex.cloud", ".convex.site")
  );
};

export const resolveServiceBaseUrl = (): string => {
  return resolveCloudBaseUrl();
};

const normalizeServicePath = (path: string): string =>
  path.startsWith("/") ? path : `/${path}`;

export const resolveServiceEndpoint = (path: string): string =>
  new URL(normalizeServicePath(path), resolveServiceBaseUrl()).toString();

export const createServiceRequest = async (
  path: string,
  headers: Record<string, string> = {},
  options: ServiceRequestOptions = {},
): Promise<ServiceRequest> => {
  const endpoint = resolveServiceEndpoint(path);
  const includeAuth = options.includeAuth ?? true;
  const includeDeviceId = options.includeDeviceId ?? true;

  const requestHeaders = includeAuth ? await getAuthHeaders(headers) : { ...headers };

  if (
    includeDeviceId &&
    !requestHeaders["X-Device-ID"]
  ) {
    try {
      const deviceId = await getOrCreateDeviceId();
      if (deviceId) {
        requestHeaders["X-Device-ID"] = deviceId;
      }
    } catch {
      // Device ID is best-effort for anonymous endpoint access.
    }
  }

  return {
    endpoint,
    headers: requestHeaders,
  };
};

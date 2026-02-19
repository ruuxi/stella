import { getAuthHeaders } from "../auth-token";
import { getLocalPort, isLocalMode } from "../local-client";

type ServiceRequest = {
  endpoint: string;
  headers: Record<string, string>;
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
  if (isLocalMode()) {
    return `http://localhost:${getLocalPort()}`;
  }
  return resolveCloudBaseUrl();
};

const normalizeServicePath = (path: string): string =>
  path.startsWith("/") ? path : `/${path}`;

export const resolveServiceEndpoint = (path: string): string =>
  new URL(normalizeServicePath(path), resolveServiceBaseUrl()).toString();

export const createServiceRequest = async (
  path: string,
  headers: Record<string, string> = {},
): Promise<ServiceRequest> => {
  const endpoint = resolveServiceEndpoint(path);
  if (isLocalMode()) {
    return {
      endpoint,
      headers: { ...headers },
    };
  }

  return {
    endpoint,
    headers: await getAuthHeaders(headers),
  };
};


import { getAuthHeaders } from "../auth-token";

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
  return {
    endpoint,
    headers: await getAuthHeaders(headers),
  };
};

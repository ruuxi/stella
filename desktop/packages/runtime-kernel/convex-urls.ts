const trimUrl = (value: string): string => value.trim().replace(/\/+$/, "");

const readConfiguredUrl = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = trimUrl(value);
  return trimmed.length > 0 ? trimmed : null;
};

export const readConfiguredConvexUrl = (
  value: string | null | undefined,
): string | null => readConfiguredUrl(value);

export const readConfiguredConvexSiteUrl = (
  value: string | null | undefined,
): string | null => readConfiguredUrl(value);

export const readConfiguredStellaBaseUrl = (
  value: string | null | undefined,
): string | null => {
  const configured = readConfiguredUrl(value);
  if (!configured) return null;
  return configured.endsWith("/api/stella/v1")
    ? configured
    : `${configured}/api/stella/v1`;
};

export const stellaBaseUrlFromConvexSiteUrl = (convexSiteUrl: string): string =>
  readConfiguredStellaBaseUrl(convexSiteUrl)!;

export const managedMediaDocsUrlFromConvexSiteUrl = (
  convexSiteUrl: string,
): string => {
  const baseUrl = readConfiguredStellaBaseUrl(convexSiteUrl)!;
  return `${baseUrl.replace(/\/api\/stella\/v1$/i, "")}/api/media/v1/docs`;
};

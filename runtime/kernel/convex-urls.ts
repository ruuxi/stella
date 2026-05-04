import {
  normalizeStellaSiteUrl,
  stellaApiBaseUrlFromSiteUrl,
} from "../contracts/stella-api.js";

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

export const readConfiguredStellaSiteUrl = (
  value: string | null | undefined,
): string | null => {
  const configured = readConfiguredUrl(value);
  if (!configured) return null;
  return normalizeStellaSiteUrl(configured);
};

export const readConfiguredStellaBaseUrl = readConfiguredStellaSiteUrl;

export const stellaApiBaseUrlFromConvexSiteUrl = (convexSiteUrl: string): string =>
  stellaApiBaseUrlFromSiteUrl(readConfiguredStellaSiteUrl(convexSiteUrl)!);

export const stellaBaseUrlFromConvexSiteUrl = stellaApiBaseUrlFromConvexSiteUrl;

/**
 * Map known `ConvexError` codes (as thrown by the backend) to
 * localized message keys in the renderer's i18n catalogs. Backend
 * `ConvexError` always carries an English `message` for logs/devs;
 * the renderer should call `localizeBackendError` to surface the
 * user-friendly version in their language.
 */

import { translate, type TranslateParams, type Catalog } from "./catalogs";

const CODE_TO_KEY: Record<string, string> = {
  RATE_LIMITED: "errors.rateLimited",
  SUBSCRIPTION_REQUIRED: "errors.subscriptionRequired",
  NETWORK_UNAVAILABLE: "errors.networkUnavailable",
  PERMISSION_DENIED: "errors.permissionDenied",
};

type ConvexErrorLike =
  | {
      data?: { code?: string; message?: string } | string;
      message?: string;
    }
  | undefined
  | null;

const extractCode = (error: ConvexErrorLike): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: unknown }).data;
  if (data && typeof data === "object") {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return undefined;
};

const extractFallbackMessage = (error: ConvexErrorLike): string | undefined => {
  if (!error) return undefined;
  if (typeof error === "object") {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const message = (data as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
};

/**
 * Resolve a backend error to a localized message. Pass the active
 * catalog (from `useI18n().t` callsites or from the fallback) and an
 * optional generic-error fallback string.
 *
 * Returns the localized string for known codes, otherwise the
 * backend's English `message`, otherwise the generic-error
 * translation.
 */
export const localizeBackendError = (
  error: unknown,
  catalog: Catalog | undefined,
  params?: TranslateParams,
): string => {
  const code = extractCode(error as ConvexErrorLike);
  if (code && CODE_TO_KEY[code]) {
    return translate(catalog, CODE_TO_KEY[code], params);
  }
  const fallback = extractFallbackMessage(error as ConvexErrorLike);
  if (fallback) return fallback;
  return translate(catalog, "errors.generic", params);
};

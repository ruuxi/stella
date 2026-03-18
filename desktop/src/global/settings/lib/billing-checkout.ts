export const BILLING_CHECKOUT_QUERY_PARAM = "billingCheckout";

const BILLING_CHECKOUT_COMPLETE_VALUE = "complete";

const getCurrentLocationUrl = () => {
  if (typeof window === "undefined" || !window.location?.href) {
    return null;
  }
  return window.location.href;
};

const parseUrl = (rawUrl: string | null) => {
  if (!rawUrl) {
    return null;
  }

  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
};

export const withCheckoutMarker = (rawUrl: string) => {
  const parsed = new URL(rawUrl);
  parsed.searchParams.set(
    BILLING_CHECKOUT_QUERY_PARAM,
    BILLING_CHECKOUT_COMPLETE_VALUE,
  );
  return parsed.toString();
};

export const hasBillingCheckoutCompletionMarker = (
  rawUrl = getCurrentLocationUrl(),
) =>
  parseUrl(rawUrl)?.searchParams.get(BILLING_CHECKOUT_QUERY_PARAM)
  === BILLING_CHECKOUT_COMPLETE_VALUE;

export const consumeBillingCheckoutCompletionMarker = () => {
  const parsed = parseUrl(getCurrentLocationUrl());
  if (
    !parsed
    || parsed.searchParams.get(BILLING_CHECKOUT_QUERY_PARAM)
      !== BILLING_CHECKOUT_COMPLETE_VALUE
  ) {
    return false;
  }

  parsed.searchParams.delete(BILLING_CHECKOUT_QUERY_PARAM);
  window.history.replaceState(window.history.state, "", parsed.toString());
  return true;
};

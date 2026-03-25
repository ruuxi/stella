const deriveConvexSiteUrl = () => {
  const explicit = process.env.EXPO_PUBLIC_CONVEX_SITE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL?.trim();
  if (!convexUrl) {
    return "";
  }

  if (convexUrl.includes(".convex.site")) {
    return convexUrl;
  }

  if (convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site");
  }

  return "";
};

export const env = {
  convexSiteUrl: deriveConvexSiteUrl(),
  convexUrl: process.env.EXPO_PUBLIC_CONVEX_URL?.trim() ?? "",
  siteUrl: process.env.EXPO_PUBLIC_SITE_URL?.trim() || "https://stella.sh",
  mobileScheme: process.env.EXPO_PUBLIC_STELLA_MOBILE_SCHEME?.trim() || "stella-mobile",
};

export const hasMobileConfig = Boolean(env.convexSiteUrl);

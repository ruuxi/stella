type StoreReviewContext = {
  packageId: string;
  displayName: string;
  description: string;
  releaseSummary?: string;
  filePath: string;
  changeType: "create" | "update" | "delete";
};

export const STORE_SECURITY_REVIEW_SYSTEM_PROMPT = [
  "You are Stella's store security reviewer.",
  "Your job is to decide whether a store release should be allowed to publish.",
  "Review only for security, abuse, privacy, or trust risks.",
  "Do not reject for style, architecture, correctness, performance, or maintainability unless they create a real security risk.",
  "Reject if the code appears to exfiltrate data, harvest secrets, log sensitive data unnecessarily, introduce hidden tracking, execute remote code, fetch and run untrusted scripts, weaken safety controls, persist unexpectedly, manipulate auth/session state suspiciously, perform destructive actions without clear user intent, or otherwise create meaningful risk for people installing the package.",
  "Assume this package can be installed by non-technical users.",
  "Be strict about real safety risks, but do not invent speculative issues.",
  "If uncertain whether something is safe enough for a public store, reject it.",
].join("\n");

export const STORE_IMAGE_SAFETY_REVIEW_SYSTEM_PROMPT = [
  "You are Stella's store image safety reviewer.",
  "Your job is to decide whether a store release image is safe to publish in a public store.",
  "Reject images that contain or strongly imply sexual content involving minors, explicit sexual content, graphic gore, self-harm encouragement, violent extremism or hate symbols used supportively, or instructions that enable harmful or illegal acts.",
  "Do not reject for aesthetics, branding quality, or harmless stylization.",
  "If uncertain whether an image is safe enough for a public store, reject it.",
].join("\n");

export const buildStoreSecurityReviewPrompt = (
  args: StoreReviewContext & {
    contentText?: string;
    patchText?: string;
  },
): string =>
  [
    `Package ID: ${args.packageId}`,
    `Display name: ${args.displayName}`,
    `Description: ${args.description}`,
    ...(args.releaseSummary ? [`Release summary: ${args.releaseSummary}`] : []),
    `File path: ${args.filePath}`,
    `Change type: ${args.changeType}`,
    "",
    "Assess whether publishing this change would create a security, abuse, privacy, or trust problem for store users.",
    "Reference patches are provided when available. Final file content is provided when available.",
    "",
    "Reference patches:",
    args.patchText?.trim() || "(none)",
    "",
    "Reference file content:",
    args.contentText?.trim() || "(none)",
  ].join("\n");

export const buildStoreImageSafetyReviewPrompt = (
  args: StoreReviewContext,
): string =>
  [
    `Package ID: ${args.packageId}`,
    `Display name: ${args.displayName}`,
    `Description: ${args.description}`,
    ...(args.releaseSummary ? [`Release summary: ${args.releaseSummary}`] : []),
    `Image path: ${args.filePath}`,
    `Change type: ${args.changeType}`,
    "",
    "Assess whether this image is safe to publish in Stella's public store.",
    "Only reject for real safety concerns.",
  ].join("\n");

// Share-link format for Stella add-ons.
//
// Internal-only deep link of the form:
//   stella://store/<authorHandle>/<packageId>
//
// Pasted into a social chat, the renderer detects this exact pattern as
// the message body and renders an `AddonShareCard` instead of the raw
// text. Outside Stella the link does nothing — there's no marketing
// site / browser handler today; the format is reserved so we can wire
// one in later without a schema break.

const SHARE_LINK_PREFIX = "stella://store/";

// Handles + packageIds are normalized lowercased ASCII identifiers in
// the same shape `normalizePackageId` enforces server-side. We accept a
// little more (uppercase / mixed) when parsing so a hand-typed link
// from the user still resolves; the resolver lower-cases when looking
// the package up.
const HANDLE_PATTERN = "[A-Za-z0-9_-]{1,64}";
const PACKAGE_PATTERN = "[A-Za-z0-9._-]{1,64}";

/**
 * `^stella://store/<handle>/<packageId>$` — anchored so we only match
 * when the entire message body is the share link. Mid-sentence pasted
 * links intentionally do NOT trigger the card embed (matches the
 * "social chat is plain text by default" model and avoids surprise
 * mid-message takeovers).
 */
const SHARE_LINK_REGEX = new RegExp(
  `^${SHARE_LINK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(${HANDLE_PATTERN})/(${PACKAGE_PATTERN})$`,
);

export type ParsedShareLink = {
  authorHandle: string;
  packageId: string;
};

export const buildShareLink = (
  authorHandle: string,
  packageId: string,
): string => {
  const handle = authorHandle.trim().toLowerCase();
  const pkg = packageId.trim().toLowerCase();
  return `${SHARE_LINK_PREFIX}${handle}/${pkg}`;
};

export const parseShareLink = (input: string): ParsedShareLink | null => {
  const trimmed = input.trim();
  const match = trimmed.match(SHARE_LINK_REGEX);
  if (!match || !match[1] || !match[2]) return null;
  return {
    authorHandle: match[1].toLowerCase(),
    packageId: match[2].toLowerCase(),
  };
};

/**
 * Convenience: returns true when a string is exactly a Stella share
 * link (no surrounding text). Use this in renderers to decide whether
 * to swap a text bubble for the embed card.
 */
export const isShareLinkOnlyMessage = (body: string): boolean =>
  parseShareLink(body) !== null;

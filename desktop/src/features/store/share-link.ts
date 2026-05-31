// Share-link format for Stella add-ons.
//
// Internal-only deep link of the form:
//   stella://store/<authorUsername>/<packageId>
//
// Pasted into a social chat, the renderer detects this exact pattern as
// the message body and renders an `AddonShareCard` instead of the raw
// text. Outside Stella the link does nothing — there's no marketing
// site / browser handler today; the format is reserved so we can wire
// one in later without a schema break.

const SHARE_LINK_PREFIX = "stella://store/";

// Usernames + packageIds are normalized lowercased ASCII identifiers in
// the same shape `normalizePackageId` enforces server-side. We accept a
// little more (uppercase / mixed) when parsing so a hand-typed link
// from the user still resolves; the resolver lower-cases when looking
// the package up.
const USERNAME_PATTERN = "[A-Za-z0-9_-]{1,64}";
const PACKAGE_PATTERN = "[A-Za-z0-9._-]{1,64}";

/**
 * `^stella://store/<username>/<packageId>$` — anchored so we only match
 * when the entire message body is the share link. Mid-sentence pasted
 * links intentionally do NOT trigger the card embed (matches the
 * "social chat is plain text by default" model and avoids surprise
 * mid-message takeovers).
 */
const SHARE_LINK_REGEX = new RegExp(
  `^${SHARE_LINK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(${USERNAME_PATTERN})/(${PACKAGE_PATTERN})$`,
);

export type ParsedShareLink = {
  authorUsername: string;
  packageId: string;
};

export const buildShareLink = (
  authorUsername: string,
  packageId: string,
): string => {
  const username = authorUsername.trim().toLowerCase();
  const pkg = packageId.trim().toLowerCase();
  return `${SHARE_LINK_PREFIX}${username}/${pkg}`;
};

export const parseShareLink = (input: string): ParsedShareLink | null => {
  const trimmed = input.trim();
  const match = trimmed.match(SHARE_LINK_REGEX);
  if (!match || !match[1] || !match[2]) return null;
  return {
    authorUsername: match[1].toLowerCase(),
    packageId: match[2].toLowerCase(),
  };
};

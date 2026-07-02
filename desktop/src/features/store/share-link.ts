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

import { parseSocialInviteLink } from "@/shared/social/invite-links";

const SHARE_LINK_PREFIX = "stella://store/";

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

/**
 * Anchored to the whole message body, so a mid-sentence pasted link does
 * NOT trigger the card embed (matches the "social chat is plain text by
 * default" model and avoids surprise mid-message takeovers). The grammar
 * itself lives in `src/shared/social/invite-links.ts` — one definition
 * shared with the deep-link funnel and the invite dialog.
 */
export const parseShareLink = (input: string): ParsedShareLink | null => {
  const parsed = parseSocialInviteLink(input);
  return parsed?.kind === "view-store-package"
    ? { authorUsername: parsed.authorUsername, packageId: parsed.packageId }
    : null;
};

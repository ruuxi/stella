/**
 * Tiny module-level registry that lets a secondary composer (currently
 * just the Store side-panel composer) "claim" dictation while its
 * textarea is focused.
 *
 * The main chat / sidebar composers intentionally do not rely on
 * textarea focus — they own dictation whenever the app is focused.
 * That's still the default behaviour: `useDictation` instances that
 * pass no `claimId` only respond to the toggle event when no one has
 * claimed dictation. The Store composer instance passes its own
 * `claimId` and only responds while it holds the claim.
 *
 * Keeping the claim as a single string (rather than a stack) is
 * deliberate — if more composers add themselves later, last-focus-wins
 * is the rule we want: the user is typing in one place at a time.
 */

let claimedComposerId: string | null = null;

export function claimDictationComposer(id: string): void {
  if (!id) return;
  claimedComposerId = id;
}

export function releaseDictationComposer(id: string): void {
  if (claimedComposerId === id) {
    claimedComposerId = null;
  }
}

export function getClaimedDictationComposer(): string | null {
  return claimedComposerId;
}

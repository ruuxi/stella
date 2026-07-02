// The invite-link grammar lives in `src/shared/social/invite-links.ts` so
// the electron main process parses with the exact same rules (main must
// never accept a deep link the renderer then drops). Social UI code keeps
// importing from here.
export * from "@/shared/social/invite-links";

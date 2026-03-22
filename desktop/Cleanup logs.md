# Cleanup Logs

This file tracks the areas reviewed in the latest frontend cleanup pass so future passes can target different surfaces without repeating the same sweep.

## Reviewed This Pass

### Auth
- `src/app/auth/useMagicLinkAuth.ts`
- `src/app/auth/InlineAuth.tsx`
- `src/app/auth/AuthDialog.tsx`
- `src/app/auth/AuthPanel.tsx`
- `tests/renderer/app/auth/InlineAuth.test.tsx`

### Overlay
- `src/app/overlay/AutoPanel.tsx`

### Composer / Chat Context
- `src/app/chat/composer-context.ts`
- `src/app/chat/ComposerContextRow.tsx`
- `src/app/chat/Composer.tsx`
- `src/app/shell/mini/MiniInput.tsx`
- `tests/renderer/app/shell/mini/MiniInput.test.tsx`
- `tests/renderer/app/chat/Composer.test.tsx`

### Onboarding
- `src/app/onboarding/OnboardingStep1.tsx`
- `src/app/onboarding/selfmod-demo.css`
- `src/app/onboarding/Onboarding.css`
- `src/app/onboarding/index.ts`
- `tests/renderer/app/onboarding/OnboardingStep1.test.tsx`

### Home
- `src/app/home/HomeView.tsx`
- `src/app/home/ActivityFeed.tsx`
- `src/app/home/ImageGallery.tsx`
- `src/app/home/NewsFeed.tsx`
- `src/app/home/DashboardCard.tsx`
- `src/app/home/home-dashboard.css`
- `src/app/home/schedule-item.ts`

### Settings
- `src/app/settings/SettingsView.tsx`
- `src/app/settings/settings.css`
- `tests/renderer/app/settings/SettingsView.test.tsx`

## Repo Signals Checked

### Lint
- `bun run lint`

### Targeted Tests
- `bun run test:run -- tests/renderer/app/auth/InlineAuth.test.tsx tests/renderer/app/shell/mini/MiniInput.test.tsx tests/renderer/app/settings/SettingsView.test.tsx tests/renderer/app/onboarding/OnboardingStep1.test.tsx`

## Suggested Next Areas

These were touched peripherally or showed signs of nearby cleanup work, but were not part of the main fix set:

- `src/app/onboarding/OnboardingDiscovery.tsx`
- `src/app/onboarding/use-onboarding-state.ts`
- `tests/renderer/app/onboarding/OnboardingDiscovery.test.tsx`
- `src/app/chat/streaming/`
- `src/app/home/GenerativeCanvas.tsx`
- `src/app/home/SuggestionsPanel.tsx`
- `src/app/home/ActiveTasks.tsx`
- `electron/ipc/handlers/browser-handlers.ts`
- `electron/system/collect-all.ts`
- `electron/system/discovery-types.ts`

## Notes

- The goal of this log is coverage tracking, not a changelog.
- If you do another cleanup pass, add a new section instead of rewriting this one.

---

## Reviewed This Pass (2026-03-08)

### Electron Contracts / Mini Bridge
- `electron/chat-context.ts`
- `electron/mini-bridge.ts`
- `electron/preload.ts`
- `electron/services/capture-service.ts`
- `electron/services/mini-bridge-service.ts`
- `electron/services/radial-gesture-service.ts`
- `electron/ipc/handlers/mini-bridge-handlers.ts`
- `electron/types.ts`

### Chat Streaming Type Shims
- `src/app/chat/hooks/use-streaming-chat.ts`
- `src/app/chat/use-turn-view-models.ts`
- `src/app/chat/ChatColumn.tsx`
- `src/app/chat/ConversationEvents.tsx`
- `src/app/shell/mini/MiniBridgeRelay.tsx`
- `src/app/shell/mini/use-context-capture.ts`

### Music Prompt / Type Shims
- `src/app/music/services/lyria-music.ts`
- `src/app/music/services/lyria-prompts.ts`
- `src/app/music/hooks/use-lyria-music.ts`
- `src/app/home/MusicPlayer.tsx`

### Dead Prompt Wrapper Modules
- `src/prompts/index.ts`
- `src/prompts/catalog.ts`
- `src/prompts/suggestions.ts`
- `src/prompts/skill_selection.ts`
- `src/prompts/personalized_dashboard.ts`

### Package Compatibility Debt
- `packages/ai/utils/oauth/index.ts`
- `packages/ai/utils/oauth/types.ts`

## Repo Signals Checked (2026-03-08)

### Lint
- `bun run lint`

### Typecheck
- `bunx --package typescript@5.9.3 tsc -p tsconfig.app.json --noEmit`
- `bunx --package typescript@5.9.3 tsc -p tsconfig.electron.json --noEmit`

### Targeted Tests
- `bun run test:run -- tests/renderer/app/shell/mini/use-context-capture.test.ts tests/renderer/app/shell/mini/use-mini-chat.test.ts tests/renderer/app/chat/hooks/use-streaming-chat.test.ts tests/renderer/app/chat/use-turn-view-models.test.tsx`

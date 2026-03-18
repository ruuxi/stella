---
id: frontend-architecture
name: Frontend Architecture Reference
description: Full design system reference covering directory structure, layout, CSS tokens, and workspace content. Activate before structural changes.
agentTypes:
  - general
tags:
  - architecture
  - design-system
  - reference
version: 2
---

# Frontend Architecture Reference

## Technology Stack
- React 19 and TypeScript in Electron with Vite and HMR
- Tailwind CSS v4 with classes directly and no config file
- CSS custom properties on `:root` for theming with OKLCH colors
- Radix UI primitives for accessible components
- CVA for component variants
- Path alias: `@/*` maps to `src/*`

## Source Layout
```text
desktop/src/
|-- main.tsx                       # Entry point, provider nesting, CSS imports
|-- App.tsx                        # Window router (full/mini based on window type)
|-- overlay-entry.tsx              # Separate overlay window entry
|-- index.css                      # Root styles, CSS custom properties
|
|-- app/                           # App pages & feature views
|   |-- chat/                      # Chat interface
|   |   |-- ChatColumn.tsx         # Main chat display
|   |   |-- Composer.tsx           # Message input with context
|   |   |-- MessageTurn.tsx        # Message rendering
|   |   |-- ConversationEvents.tsx # Event handling
|   |   |-- hooks/                 # use-streaming-chat, use-command-suggestions, etc.
|   |   |-- lib/                   # message-display, context-window, event-transforms
|   |   |-- streaming/             # agent-stream-errors, streaming-types
|   |   `-- *.css
|   |-- home/                      # Home dashboard view
|   |   |-- HomeView.tsx           # Dashboard layout
|   |   |-- GenerativeCanvas.tsx   # Morphdom-based live canvas
|   |   |-- ActivityFeed.tsx       # Activity feed display
|   |   |-- SuggestionsPanel.tsx   # Suggestions widget
|   |   |-- DashboardCard.tsx      # Card component
|   |   |-- MusicPlayer.tsx        # Music playback UI
|   |   |-- hooks/                 # use-welcome-suggestions, etc.
|   |   `-- *.css
|   |-- workspace/                 # Workspace panels
|   |   |-- WorkspaceArea.tsx      # View router (home/app/onboarding)
|   |   |-- WorkspaceErrorBoundary.tsx
|   |   `-- renderers/             # panel.tsx, dev-project-panel.tsx, hosted-game-panel.tsx
|   `-- social/                    # Social/friends view
|       |-- SocialView.tsx
|       `-- *.css
|
|-- shell/                         # Main shell & layout
|   |-- FullShell.tsx              # Full window layout (sidebar + workspace + chat)
|   |-- FloatingOrb.tsx            # Floating AI avatar
|   |-- TitleBar.tsx               # Window title bar
|   |-- ErrorBoundary.tsx          # App-level error boundary with revert
|   |-- full-shell-dialogs.tsx     # Dialog registry
|   |-- sidebar/
|   |   `-- Sidebar.tsx            # Left navigation
|   |-- mini/
|   |   |-- MiniShell.tsx          # Compact mode layout
|   |   `-- MiniInput.tsx
|   |-- overlay/
|   |   |-- OverlayRoot.tsx        # Overlay container
|   |   |-- RadialDial.tsx         # Radial menu
|   |   |-- RegionCapture.tsx      # Screen region capture
|   |   `-- VoiceOverlay.tsx
|   |-- ascii-creature/
|   |   `-- StellaAnimation.tsx    # Stella animation (WebGL shader)
|   |-- hooks/                     # use-full-shell-chat, use-orb-message, etc.
|   `-- *.css
|
|-- context/                       # React context state
|   |-- AppProviders.tsx           # Provider composition
|   |-- ui-state.tsx               # UI mode, view, window state
|   |-- workspace-state.tsx        # Workspace panel state
|   |-- chat-store.tsx             # Chat/conversation state
|   |-- theme-context.tsx          # Theme selection & colors
|   `-- dev-projects-state.tsx     # Dev project registry
|
|-- global/                        # Global features & systems
|   |-- auth/                      # Authentication (deep link, magic link, credentials)
|   |-- settings/                  # Settings page, theme picker, model prefs
|   |-- onboarding/                # Onboarding flow, discovery, synthesis
|   |-- integrations/              # Third-party service connections
|   `-- store/                     # Marketplace/store
|
|-- ui/                            # UI component library (60+ paired .tsx/.css)
|   |-- button.tsx / .css          # Button, icon-button, etc.
|   |-- dialog.tsx / .css          # Dialog, popover, dropdown-menu
|   |-- card.tsx / .css            # Card surfaces
|   |-- text-field.tsx / .css      # Text input
|   |-- tabs.tsx / .css            # Tab navigation
|   `-- ...                        # select, checkbox, switch, slider, tag, tooltip, etc.
|
|-- shared/                        # Shared utilities & contracts
|   |-- contracts/                 # IPC/API type interfaces
|   |-- types/                     # electron.d.ts (window.electronAPI)
|   |-- theme/                     # Color utilities, theme definitions (OKLCH)
|   |   `-- themes/                # aura, catppuccin, dracula, nord, tokyonight, etc.
|   |-- styles/                    # app-base.css, app-components.css, fonts.css
|   |-- components/                # Shared reusable components
|   |-- hooks/                     # use-ipc-query, use-window-type, etc.
|   `-- lib/                       # color, layout, safe-html, utils
|
|-- systems/                       # Core runtime systems
|   |-- boot/                      # AppBootstrap, conversation bootstrap, self-mod taint
|   `-- voice/                     # Voice runtime, wake word capture
|
|-- features/                      # Feature modules
|   |-- games/                     # Multiplayer game bindings & hooks
|   |-- media/                     # Media handling services
|   |-- music/                     # Music playback hooks & services
|   `-- voice/                     # Voice feature hooks & services
|
|-- platform/                      # Platform-specific code
|   |-- electron/                  # Electron integration (device, platform, screenshot)
|   `-- dev/                       # Vite HMR error recovery (dev only)
|
|-- prompts/                       # Agent prompt library (catalog, synthesis, voice, etc.)
|-- infra/                         # AI/LLM integration, HTTP utilities, Convex client
|-- debug/                         # Trace logging, debug hooks
`-- convex/                        # Convex server code
```

## View System
The app uses `ViewType = 'home' | 'app'` to control what `WorkspaceArea` displays.

- `'home'`: renders `HomeView` from `src/app/home/HomeView.tsx`
- `'app'`: renders workspace content selected from the shell

`WorkspaceArea.tsx` handles the routing. Local workspace panels are surfaced through the shell's own workspace selection UI.

## Key Layout Structure
```text
.full-body (flex-direction: row)
|-- Sidebar (left nav)
|-- WorkspaceArea (flex: 1)
|   |-- HomeView
|   `-- Workspace content (when view === 'app')
`-- ChatColumn (right side, collapsible)
    `-- Composer (messages + input)
```

## CSS Design Tokens
```css
/* Text hierarchy */
--text-strong, --text-base, --text-weak, --text-weaker

/* Surfaces */
--surface-inset, --surface-raised, --surface-raised-hover, --surface-overlay

/* Borders */
--border-base, --border-weak, --border-strong

/* Interactive */
--interactive, --interactive-hover

/* Sizing */
--radius-sm, --radius-md, --radius-lg, --radius-full
--font-family-mono
```

## Workspace Content
Interactive content rendered in `WorkspaceArea` when the view is `'app'`:
- Panels: renderers in `src/app/workspace/renderers/` (dev-project, hosted-game)
- Generated dashboard pages: `src/app/{panelName}/{PanelName}.tsx` (written by self-mod agent, picked up by HMR)
- Page registry: `src/app/registry.ts` — agents append entries using the Edit tool (fs-locked across concurrent tasks)

Agents create the page folder, write the component, then Edit `registry.ts` to add their entry.

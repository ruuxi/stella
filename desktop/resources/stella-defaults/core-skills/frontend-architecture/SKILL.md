---
id: frontend-architecture
name: Frontend Architecture Reference
description: Full design system reference covering directory structure, layout, CSS tokens, slot system, and workspace content. Activate before structural changes.
agentTypes:
  - general
tags:
  - architecture
  - design-system
  - reference
version: 1
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
|-- main.tsx                    # Entry point, provider nesting, CSS imports
|-- App.tsx                     # Window router (full/mini/radial/region)
|-- app/state/
|   |-- ui-state.tsx            # UiStateProvider (mode, window, view, conversationId)
|   `-- workspace-state.tsx     # WorkspaceProvider (active panel, chatWidth, isChatOpen)
|-- views/
|   `-- home/
|       |-- HomeView.tsx        # Default home screen (suggestions, tasks, schedule)
|       `-- home-view.css       # Home view styles
|-- components/
|   |-- workspace/
|   |   `-- WorkspaceArea.tsx   # View router (home/app/onboarding)
|   |-- canvas/
|   |   |-- WorkspaceErrorBoundary.tsx # Error boundary for workspace panel renderers
|   |   `-- renderers/          # panel.tsx (Vite dynamic), appframe.tsx (iframe)
|   |-- chat/                   # Message rendering (Markdown, TurnItem, etc.)
|   |-- Sidebar.tsx             # Left navigation (Home, Connect)
|   |-- ErrorBoundary.tsx       # App-level error boundary with revert
|   |-- button.tsx / .css       # Button component pattern for primitives
|   `-- ...                     # Additional component files with paired CSS
|-- screens/
|   |-- FullShell.tsx           # Re-export from full-shell/
|   |-- full-shell/
|   |   |-- FullShell.tsx       # Layout shell (sidebar + workspace + chat)
|   |   |-- ChatColumn.tsx      # Chat area (messages + composer)
|   |   |-- Composer.tsx        # Input bar, attachments, submit
|   |   |-- OnboardingOverlay.tsx
|   |   |-- DiscoveryFlow.tsx
|   |   |-- use-streaming-chat.ts
|   |   `-- use-full-shell.ts
|   |-- MiniShell.tsx
|   |-- RadialDial.tsx
|   `-- RegionCapture.tsx
|-- plugins/
|   |-- registry.ts             # Slot registry
|   |-- types.ts
|   `-- slots.ts
|-- styles/
|   |-- workspace.css
|   |-- full-shell.layout.css
|   |-- full-shell.composer.css
|   `-- ...
`-- theme/
    |-- theme-context.tsx
    |-- themes.ts
    `-- color.ts
```

## View System
The app uses `ViewType = 'home' | 'app'` to control what `WorkspaceArea` displays.

- `'home'`: renders `HomeView` from `src/views/home/HomeView.tsx`
- `'app'`: renders workspace content selected from the shell

`WorkspaceArea.tsx` handles the routing. Local workspace panels are surfaced through the shell's own workspace selection UI rather than a backend event bridge.

## Key Layout Structure
```text
.full-body (flex-direction: row)
|-- Sidebar (left nav, about 240px)
|-- WorkspaceArea (flex: 1)
|   |-- HomeView
|   `-- Workspace content (when view === 'app' and workspace content is active)
`-- ChatPanel (right side, collapsible)
    `-- ChatColumn (messages + composer)
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

## Slot System
Components are registered in named slots that can be overridden:

```typescript
import { useSlot, overrideSlot } from '@/plugins';

const SidebarSlot = useSlot('sidebar');

overrideSlot('sidebar', MyCustomSidebar, { priority: 10, source: 'self-mod' });
```

## Workspace Content
Interactive content rendered in `WorkspaceArea` when the view is `'app'`:
- Panels: single-file TSX in `desktop/workspace/panels/`
- Apps: full Vite+React projects in `desktop/workspace/apps/`

Agents create the content, then report the panel name or local app URL so the user can open it through the workspace UI.

# Stella Frontend Architecture

## Quick Reference

### "Change the theme / colors"
- `src/theme/themes.ts` — Theme definitions (light/dark palettes)
- `src/theme/theme-context.tsx` — Theme provider + CSS variable injection
- `src/theme/color.ts` — OKLCH color utilities for gradient generation
- `src/index.css` — Design tokens (`--color-*`, `--radius-*`, `--shadow-*`)

### "Change the prompt bar / input"
- `src/components/chat/` — Chat input components
- `src/styles/full-shell.composer.css` — Composer layout styles

### "Change chat messages"
- `src/components/chat/Markdown.tsx` — Message rendering
- `src/components/chat/MessageGroup.tsx` — Message grouping
- `src/components/chat/ReasoningSection.tsx` — Reasoning display
- `src/styles/full-shell.chat.css` — Message styles

### "Change the radial menu"
- `src/screens/RadialDial.tsx` — Menu component
- `src/screens/RadialShell.tsx` — Radial window shell
- `electron/radial-window.ts` — Window management

### "Add a new tool"
1. Create handler in appropriate `electron/local-host/tools-*.ts` file
2. Register in `electron/local-host/tools.ts` handlers object
3. Tool files by domain:
   - `tools-file.ts` — Read, Write, Edit
   - `tools-search.ts` — Glob, Grep
   - `tools-shell.ts` — Bash, SkillBash, KillShell
   - `tools-web.ts` — WebFetch, WebSearch
   - `tools-state.ts` — TodoWrite, TestWrite, Task, TaskOutput
   - `tools-user.ts` — AskUserQuestion, RequestCredential
   - `tools-database.ts` — SqliteQuery

### "Change window behavior"
- `electron/main.ts` — Main process, window creation
- `electron/radial-window.ts` — Radial menu window
- `electron/region-capture-window.ts` — Screen capture window
- `electron/preload.ts` — Preload scripts (IPC bridge)

### "Modify screen/shell components"
- `src/screens/FullShell.tsx` — Main application window
- `src/screens/MiniShell.tsx` — Spotlight-style overlay
- `src/screens/RadialShell.tsx` — Transparent radial overlay

---

## Directory Structure

```
src/
├── components/         # Reusable UI (Button, Dialog, etc.)
│   ├── chat/           # Chat-specific components (Markdown, MessageGroup)
│   └── background/     # Background effects
├── screens/            # Window entry points (FullShell, MiniShell, RadialDial)
├── theme/              # Theme definitions + color utilities
├── styles/             # Layout CSS by region (full-shell.*, mini-shell.css)
├── hooks/              # React hooks
├── lib/                # Utilities
├── services/           # Backend integration (convex-client, model-gateway)
├── app/                # Auth + bootstrap
├── convex/             # Convex client types (api.ts)
└── types/              # TypeScript type definitions

electron/
├── main.ts             # Electron main process
├── preload.ts          # Preload scripts (IPC bridge)
├── local-host/         # Tool implementations
│   ├── tools.ts        # Tool host factory + registry
│   ├── tools-types.ts  # Shared type definitions
│   ├── tools-utils.ts  # Shared utilities
│   ├── tools-file.ts   # Read/Write/Edit handlers
│   ├── tools-search.ts # Glob/Grep handlers
│   ├── tools-shell.ts  # Bash/SkillBash/KillShell handlers
│   ├── tools-web.ts    # WebFetch/WebSearch handlers
│   ├── tools-state.ts  # Todo/Test/Task handlers
│   ├── tools-user.ts   # AskUser/RequestCredential handlers
│   ├── tools-database.ts # SqliteQuery handler
│   ├── runner.ts       # Tool request runner (polls Convex)
│   ├── skills.ts       # Skill loading from ~/.stella
│   ├── agents.ts       # Agent loading from ~/.stella
│   └── plugins.ts      # Plugin loading from ~/.stella
├── radial-window.ts    # Radial menu window management
└── region-capture-window.ts # Screen capture window
```

---

## Styling Patterns

### Component Styles
Each component typically has a paired `.tsx`/`.css` file:
- `src/components/button.tsx` + `src/components/button.css`
- `src/components/dialog.tsx` + `src/components/dialog.css`

### Layout Styles
Layout styles are organized by screen region in `src/styles/`:
- `full-shell.layout.css` — Main window layout
- `full-shell.chat.css` — Chat message area
- `full-shell.composer.css` — Input/prompt bar
- `full-shell.panels.css` — Side panels
- `mini-shell.css` — Mini/spotlight window

### Design Tokens
Global tokens in `src/index.css`:
- `--color-*` — Color palette
- `--radius-*` — Border radii
- `--shadow-*` — Box shadows

---

## Protected Areas (avoid modifying)

- `src/app/` — Auth bootstrapping
- `src/convex/` — Convex client setup (generated types)
- `electron/main.ts` core IPC — Only extend, don't restructure

---

## Multi-Window Architecture

The app has three window types, determined by `?window=` query parameter:
- **Full** (`FullShell.tsx`): Main application window with full chat interface
- **Mini** (`MiniShell.tsx`): Spotlight-style overlay for quick interactions
- **Radial** (`RadialShell.tsx`): Transparent overlay for the radial menu

---

## Local Host Tool System

Tools execute locally on the user's device via the local host runner:
1. `runner.ts` polls Convex for tool requests targeted at this device
2. `tools.ts` factory creates tool host with all handlers registered
3. Individual `tools-*.ts` files contain domain-specific implementations
4. Results are sent back to Convex for the model to consume

# UI Components

This directory contains reusable UI components built on Radix UI primitives.

## Conventions

### File Structure

Components use paired `.tsx` and `.css` files:
```
button.tsx      # Component implementation
button.css      # Component styles
```

### Naming

- Reusable primitives: lowercase with hyphens (`dropdown-menu.tsx`)
- App-level components: PascalCase (`Sidebar.tsx`, `ThemePicker.tsx`)
- Components: PascalCase (`DropdownMenu`)
- CSS classes: lowercase with hyphens (`.dropdown-menu-item`)

### Exports

All public reusable components are re-exported from `index.ts`:
```typescript
export { Button } from "./button"
export { Dialog, DialogContent, DialogTitle } from "./dialog"
```

App-level components (Sidebar, ThemePicker, AuthStatus, etc.) are imported directly.

## Component Categories

### Primitives (Radix-based)
Built on Radix UI with custom styling:
- `button.tsx` - Button variants
- `dialog.tsx` - Modal dialogs
- `dropdown-menu.tsx` - Dropdown menus
- `popover.tsx` - Popovers
- `select.tsx` - Select inputs
- `tabs.tsx` - Tab navigation
- `tooltip.tsx` - Tooltips
- `accordion.tsx` - Accordion panels
- `collapsible.tsx` - Collapsible sections
- `hover-card.tsx` - Hover cards
- `radio-group.tsx` - Radio button groups
- `toast.tsx` - Toast notifications

### Layout
- `card.tsx` - Card containers
- `list.tsx` - List containers
- `steps-container.tsx` - Step-based layouts

### Form
- `text-field.tsx` - Text inputs
- `checkbox.tsx` - Checkboxes
- `switch.tsx` - Toggle switches
- `slider.tsx` - Range sliders
- `radio-group.tsx` - Radio groups
- `icon-button.tsx` - Icon buttons
- `inline-input.tsx` - Inline editable text

### Chat (`chat/`)
- `Markdown.tsx` - Message rendering with syntax highlighting
- `MessageGroup.tsx` - Message grouping by author
- `ReasoningSection.tsx` - AI reasoning display
- `TaskIndicator.tsx` - Task progress indicators
- `WorkingIndicator.tsx` - Loading states

### Canvas (`canvas/`)
Side panel system for rendering interactive content:
- `CanvasPanel.tsx` - Main panel with resize handle and header. Routes by URL: url → iframe, else → Vite dynamic import
- `CanvasErrorBoundary.tsx` - Error boundary for renderer crashes
- `renderers/panel.tsx` - Vite-compiled single-file TSX from `workspace/panels/`
- `renderers/appframe.tsx` - Sandboxed iframe for workspace apps (`~/.stella/apps/`)

### Other Subdirectories
- `background/` - `ShiftingGradient.tsx` animated background
- `ascii-creature/` - WebGL ASCII art rendering
- `onboarding/` - Onboarding flow components

## Styling Patterns

### CSS Custom Properties

Use design tokens from `src/index.css`:
```css
.my-component {
  color: var(--foreground);
  background: var(--background);
  border-radius: var(--radius-md);
}
```

### Data Attribute Variants

Components use `data-*` attributes for variant styling:
```typescript
<button data-variant="default" data-size="md" />
```
```css
.button[data-variant="destructive"] { ... }
.button[data-size="sm"] { ... }
```

### Tailwind

Tailwind utilities can be combined with component CSS using `cn()`:
```typescript
<Button className={cn("mt-4", className)} />
```

## When to Create New Components

1. **Reused 3+ times** - Extract to a component
2. **Complex interaction** - Wrap Radix primitive
3. **Domain-specific** - Place in appropriate subdirectory (e.g., `chat/`)

## Radix UI Usage

Always use Radix primitives for:
- Dialogs/modals
- Dropdown menus
- Popovers
- Tooltips
- Select inputs
- Accessible form controls

This ensures keyboard navigation, focus management, and accessibility.

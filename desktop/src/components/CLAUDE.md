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

- Files: lowercase with hyphens (`dropdown-menu.tsx`)
- Components: PascalCase (`DropdownMenu`)
- CSS classes: lowercase with hyphens (`.dropdown-menu-item`)

### Exports

All public components are re-exported from `index.ts`:
```typescript
export { Button } from "./button"
export { Dialog, DialogContent, DialogTitle } from "./dialog"
```

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

### Layout
- `card.tsx` - Card containers
- `separator.tsx` - Visual separators
- `scroll-area.tsx` - Custom scrollbars

### Form
- `input.tsx` - Text inputs
- `checkbox.tsx` - Checkboxes
- `switch.tsx` - Toggle switches
- `slider.tsx` - Range sliders

### Chat-Specific (`chat/`)
- `Markdown.tsx` - Message rendering with syntax highlighting
- `MessageGroup.tsx` - Message grouping by author
- `ReasoningSection.tsx` - AI reasoning display
- `TaskIndicator.tsx` - Task progress indicators
- `WorkingIndicator.tsx` - Loading states

## Styling Patterns

### CSS Custom Properties

Use design tokens from `src/index.css`:
```css
.my-component {
  color: var(--color-foreground);
  background: var(--color-background);
  border-radius: var(--radius-md);
}
```

### Class Variance Authority

Complex components use `cva` for variants:
```typescript
const buttonVariants = cva("button-base", {
  variants: {
    variant: {
      default: "button-default",
      destructive: "button-destructive",
    },
    size: {
      sm: "button-sm",
      md: "button-md",
    },
  },
});
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

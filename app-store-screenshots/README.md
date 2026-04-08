# Stella Marketing Asset Studio

This is a small Next.js export tool for Stella marketing assets. It lives at repo root (`app-store-screenshots/`) and is **not** part of the Expo app: it does not import any modules from `mobile/`. Icon files under `public/` are copied in manually when you want them to match `mobile/assets/`.

## What it does

- Renders live Stella animation icon concepts on HTML for static PNG export
- Renders six App Store slides as marketing ads, not literal UI docs
- Uses Stella's real mobile icon assets and repo-derived product copy
- Supports `Carbon`, `Midnight`, and `Editorial` visual themes
- Supports both `iPhone` and `iPad` layouts
- Exports PNGs at Apple's portrait screenshot sizes

## Assumptions

- No raw mobile screenshot set was present, so the tool generates polished mock UI based on the real mobile flows in `mobile/app/(main)` and `mobile/app/(auth)`.
- The narrative arc is:
  1. desktop control on your phone
  2. everyday chat
  3. real computer tasks
  4. quick pairing
  5. flexible input
  6. personalization and polish

## Run it

```bash
cd app-store-screenshots
bun dev
```

Then open `http://localhost:3000`.

## Export workflow

### Icon concepts

1. Open the `Stella Asset Studio` section.
2. Pick a surface, background, and animation state.
3. Freeze a frame if you want a specific static moment.
4. Export a single PNG or the `256 / 512 / 1024` set.

### App Store slides

1. Pick a theme.
2. Pick `iPhone` or `iPad`.
3. Pick the target export size.
4. Use `Export current` or `Export all`.

Exports are named with a numeric prefix so they sort correctly in Finder and App Store Connect upload folders.

## Key files

- `src/app/page.tsx`: all slide definitions, mock screens, toolbar controls, and export logic
- `src/components/StellaIconStudio.tsx`: live Stella animation icon preview and PNG export controls
- `src/components/stella-animation/*`: WebGL renderer adapted for the asset studio
- `src/app/layout.tsx`: Stella-aligned font setup
- `public/app-icon.png`: copied from `mobile/assets/icon.png`
- `public/splash-icon.png`: copied from `mobile/assets/splash-icon.png`
- `public/mockup.png`: iPhone frame asset used for export

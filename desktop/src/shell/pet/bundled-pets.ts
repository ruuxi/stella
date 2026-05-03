import type { BuiltInPet } from "./built-in-pets";

/**
 * Pets that ship inside the desktop app instead of being served from the
 * Convex catalog / R2 bucket. Their spritesheets are bundled under
 * `desktop/public/pets/<id>.webp`, so they always work offline and are
 * available even before the Convex catalog query has hydrated.
 *
 * The default pet (`DEFAULT_PET_ID`) must always exist in this list so
 * that the floating overlay's `useSelectedPet` hook can never resolve
 * to `null` for a brand-new install.
 */
export const BUNDLED_PETS: BuiltInPet[] = [
  {
    id: "dotbloom",
    displayName: "Dotbloom",
    description:
      "A soft dotted bloom-shaped digital companion with cyan eyes and pastel blue-green pixel-dot body.",
    kind: "creature",
    tags: ["cute", "default", "pixel"],
    ownerName: "Stella",
    spritesheetUrl: "/pets/dotbloom.webp",
    sourceUrl: "",
    creator: "Stella",
    downloads: 0,
  },
];

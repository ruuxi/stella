import { useEffect, useMemo, useState } from "react";
import { api } from "@/convex/api";
import { useConvexOneShot } from "@/shared/lib/use-convex-one-shot";
import {
  PET_BY_ID_STORAGE_KEY,
  getCachedPetById,
  writeCachedPetById,
} from "./pet-catalog-cache";
import { BUNDLED_PETS } from "./bundled-pets";
import { normalizePet, type BuiltInPet } from "./built-in-pets";

const findBundled = (id: string | null | undefined): BuiltInPet | null => {
  if (!id) return null;
  return BUNDLED_PETS.find((pet) => pet.id === id) ?? null;
};

const normalizeUserPet = (pet: unknown): BuiltInPet | null => {
  if (!pet || typeof pet !== "object") return null;
  const row = pet as {
    petId?: string;
    displayName?: string;
    description?: string;
    spritesheetUrl?: string;
    authorUsername?: string;
    installCount?: number;
  };
  return normalizePet({
    id: row.petId,
    displayName: row.displayName,
    description: row.description,
    kind: "custom",
    tags: ["custom"],
    ownerName: row.authorUsername ? `@${row.authorUsername}` : null,
    spritesheetUrl: row.spritesheetUrl,
    sourceUrl: "",
    downloads: row.installCount,
  });
};

/**
 * Resolve the currently-selected pet for the floating overlay. Three
 * layers, in priority order:
 *
 *   1. Bundled pet — synchronous, ships with the app, always renderable
 *      offline. Only the bundled `stella` default lives here today, but any
 *      pet baked into `desktop/public/pets/` would short-circuit here.
 *   2. Cached pet record from a previous session — synchronous, survives
 *      reloads, written every time the live query yields a fresh value.
 *   3. Live Convex query — authoritative, replaces the cache when it
 *      hydrates so the overlay reflects metadata changes (rename,
 *      sprite re-upload, …) on next mount.
 */
export const useSelectedPet = (
  selectedPetId: string | null | undefined,
): BuiltInPet | null => {
  const bundled = useMemo(() => findBundled(selectedPetId), [selectedPetId]);
  const [cached, setCached] = useState<BuiltInPet | null>(() =>
    selectedPetId ? getCachedPetById(selectedPetId) : null,
  );

  useEffect(() => {
    setCached(selectedPetId ? getCachedPetById(selectedPetId) : null);
  }, [selectedPetId]);

  // Cross-window cache sync — if another renderer (the pets app, the
  // sidebar, …) hydrates a fresh pet record, mirror it into the
  // overlay's local state so we don't show a stale name/sprite.
  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key !== PET_BY_ID_STORAGE_KEY) return;
      setCached(selectedPetId ? getCachedPetById(selectedPetId) : null);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [selectedPetId]);

  // Skip the query when there's no selection or when the bundled record
  // is sufficient — bundled pets aren't in Convex and would always
  // resolve to `null`, which would force a flicker back to the bundled
  // fallback for no benefit.
  //
  // One-shot, not a subscription: per-pet metadata is effectively
  // immutable post-publish, and the pet overlay window is long-lived.
  // Each `useQuery` here used to keep a Convex watcher open per
  // selected pet for the whole session.
  const remote = useConvexOneShot(
    api.data.pets.getByPetId,
    selectedPetId && !bundled ? { id: selectedPetId } : "skip",
  );
  const userPet = useConvexOneShot(
    api.data.user_pets.getByPetId,
    selectedPetId && !bundled ? { petId: selectedPetId } : "skip",
  );

  useEffect(() => {
    const record = remote ? normalizePet(remote as Partial<BuiltInPet>) : null;
    const normalized = record ?? normalizeUserPet(userPet);
    if (!normalized) return;
    writeCachedPetById(normalized);
    setCached(normalized);
  }, [remote, userPet]);

  if (bundled) return bundled;
  if (cached) return cached;
  return null;
};

export type TagFacet = { tag: string; count: number };

/**
 * Read the precomputed tag facets used by the pets-page filter pills.
 * Returns `null` while loading so the caller can keep the previously
 * shown set of tags rather than flashing an empty row.
 *
 * One-shot fetch: facets are batch-recomputed on the backend and
 * almost never shift while the user is on the pets page; not worth a
 * standing subscription.
 */
export const useTagFacets = (): TagFacet[] | null => {
  const result = useConvexOneShot(api.data.pets.listTagFacets, {});
  return (result as TagFacet[] | undefined) ?? null;
};

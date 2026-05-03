import { PetsApp } from "@/app/pets/App";

/**
 * Embedded Pets settings tab. The standalone /pets sidebar route shares
 * the same component so there is exactly one picker UI to maintain —
 * the tab is just a different host for it inside Settings.
 */
export function PetsTab() {
  return <PetsApp />;
}

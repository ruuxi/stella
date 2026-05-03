import { PawPrint } from "lucide-react";
import type { AppMetadata } from "../_shared/app-metadata";

/**
 * Sidebar entry for the Pets picker. The Sidebar discovers this file
 * via `import.meta.glob("../../app/*\/metadata.ts")` in
 * `desktop/src/shell/sidebar/Sidebar.tsx` — no manual registration.
 *
 * Kept as a pure `.ts` module (no JSX) so the discovery glob keeps
 * matching; we hand the icon component reference straight from
 * `lucide-react` since `AppMetadata.icon` already accepts a component.
 */
const metadata: AppMetadata = {
  id: "pets",
  label: "Pets",
  icon: PawPrint,
  route: "/pets",
  slot: "bottom",
  order: 5,
};

export default metadata;

import { CustomSettings } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "settings",
  label: "Settings",
  icon: CustomSettings,
  route: "/settings",
  // Slot is preserved for parity with the discovery contract (every
  // `apps/<id>/metadata.ts` must declare a valid slot), but `hideFromSidebar`
  // suppresses the actual rendering — Settings now lives only in the
  // avatar dropdown rather than as a permanent rail entry.
  slot: "bottom",
  order: 20,
  hideFromSidebar: true,
};

export default metadata;

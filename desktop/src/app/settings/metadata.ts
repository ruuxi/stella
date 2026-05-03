import { CustomSettings } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "settings",
  label: "Settings",
  icon: CustomSettings,
  route: "/settings",
  // Slot is preserved for parity with the discovery contract (every
  // `app/<id>/metadata.ts` must declare a valid slot), but `hideFromSidebar`
  // suppresses the actual rendering — Settings is reached via the
  // sidebar's actions bar (gear icon) and owns its own in-page tab rail
  // rather than living as a permanent shell-rail entry.
  slot: "bottom",
  order: 20,
  hideFromSidebar: true,
};

export default metadata;

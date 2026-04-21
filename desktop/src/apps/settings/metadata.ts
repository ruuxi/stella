import { CustomSettings } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "settings",
  label: "Settings",
  icon: CustomSettings,
  route: "/settings",
  slot: "bottom",
  order: 20,
};

export default metadata;

import { CustomStore } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "store",
  label: "Store",
  icon: CustomStore,
  route: "/store",
  slot: "bottom",
  order: 10,
};

export default metadata;

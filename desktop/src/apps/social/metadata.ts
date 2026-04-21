import { CustomUsers } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "social",
  label: "Social",
  icon: CustomUsers,
  route: "/social",
  slot: "top",
  order: 20,
};

export default metadata;

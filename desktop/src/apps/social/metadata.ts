import { CustomUsers } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "social",
  label: "Social",
  icon: CustomUsers,
  route: "/social",
  // Social is a global integration, not a workspace-style "app" — it lives
  // alongside Store / Settings in the footer slot rather than next to Home
  // in the top app list.
  slot: "bottom",
  order: 30,
};

export default metadata;

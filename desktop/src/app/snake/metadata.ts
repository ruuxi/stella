import { CustomSnake } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "snake",
  label: "Snake",
  icon: CustomSnake,
  route: "/snake",
  // Sit alongside Store / Social in the footer slot — Snake is a fun
  // utility, not a workspace-style app, so it doesn't belong in the top
  // app list.
  slot: "bottom",
  order: 40,
};

export default metadata;

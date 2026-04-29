import { CustomSnake } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "snake",
  label: "Snake",
  icon: CustomSnake,
  route: "/snake",
  slot: "top",
  order: 20,
};

export default metadata;

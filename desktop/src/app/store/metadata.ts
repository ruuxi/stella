import { CustomStore } from "@/ui/nav-icons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "store",
  label: "Store",
  icon: CustomStore,
  route: "/store",
  slot: "top",
  order: 30,
};

export default metadata;

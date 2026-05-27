import type { AppMetadata } from "../_shared/app-metadata";
import MorphTestIcon from "./MorphTestIcon";

export const MORPH_TEST_RELOAD_FEATURE_ENABLED = true;
export const MORPH_TEST_RESTART_RELOAD_DETAIL_ENABLED = false;

const metadata: AppMetadata = {
  id: "morph-test",
  label: "Morph test",
  icon: MorphTestIcon,
  route: "/morph-test",
  slot: "top",
  order: 900,
};

export default metadata;

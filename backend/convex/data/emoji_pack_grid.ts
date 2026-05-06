import { v } from "convex/values";
import { query } from "../_generated/server";
import {
  EMOJI_PACK_GRID_VERSION,
  EMOJI_SHEETS,
  EMOJI_SHEET_GRID_SIZE,
} from "./emoji_pack_grid_constants";

const emojiGridManifestValidator = v.object({
  version: v.string(),
  gridSize: v.number(),
  sheets: v.array(v.array(v.string())),
});

export const getManifest = query({
  args: {},
  returns: emojiGridManifestValidator,
  handler: () => ({
    version: EMOJI_PACK_GRID_VERSION,
    gridSize: EMOJI_SHEET_GRID_SIZE,
    sheets: EMOJI_SHEETS.map((sheet) => [...sheet]),
  }),
});


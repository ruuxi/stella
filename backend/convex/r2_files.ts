import { R2 } from "@convex-dev/r2";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";

export const r2 = new R2(components.r2);

export const { generateUploadUrl, syncMetadata } = r2.clientApi<DataModel>({
  checkUpload: async (_ctx, _bucket) => {
    // Add upload permission checks here if needed
  },
  onUpload: async (_ctx, _bucket, _key) => {
    // Post-upload logic (e.g. store metadata in a table)
  },
});

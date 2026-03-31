import { createApi } from "@convex-dev/better-auth";
import { options } from "../../node_modules/@convex-dev/better-auth/dist/auth-options.js";
import schema from "./schema";

/**
 * Same pattern as the bundled Better Auth component: static `options` for
 * `getAuthTables` at module init. App-level auth uses `createAuth` in `../auth`.
 */
export const {
  create,
  findOne,
  findMany,
  updateOne,
  updateMany,
  deleteOne,
  deleteMany,
} = createApi(schema, () => options);

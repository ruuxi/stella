/**
 * Better Auth component schema. Mirrors `@convex-dev/better-auth` with one
 * app-specific delta: an `isAnonymous_updatedAt` index on `user` so
 * `anon_cleanup` can scan anonymous users by `updatedAt` without a full table
 * scan (see Convex query warnings).
 */
import { defineSchema } from "convex/server";
import { tables } from "./generatedTables";

export default defineSchema({
  ...tables,
  user: tables.user.index("isAnonymous_updatedAt", ["isAnonymous", "updatedAt"]),
});

/**
 * Better Auth component schema: mirrors @convex-dev/better-auth with an extra
 * compound index so `findMany` on anonymous + `updatedAt` uses an index
 * (see anon_cleanup + Convex query warnings).
 */
import { defineSchema } from "convex/server";
import { tables } from "./generatedTables";

export default defineSchema({
  ...tables,
  user: tables.user.index("isAnonymous_updatedAt", ["isAnonymous", "updatedAt"]),
});

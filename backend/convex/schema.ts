import { defineSchema } from "convex/server";
import { conversationsSchema } from "./schema/conversations";
import { agentsSchema } from "./schema/agents";
import { authSchema } from "./schema/auth";
import { integrationsSchema } from "./schema/integrations";
import { devicesSchema } from "./schema/devices";
import { usersSchema } from "./schema/users";
import { telemetrySchema } from "./schema/telemetry";
import { billingSchema } from "./schema/billing";
import { storeSchema } from "./schema/store";
import { mediaSchema } from "./schema/media";
import { socialSchema } from "./schema/social";
import { backupsSchema } from "./schema/backups";
import { fashionSchema } from "./schema/fashion";
import { feedbackSchema } from "./schema/feedback";
import { desktopReleasesSchema } from "./schema/desktop_releases";

export default defineSchema({
  ...conversationsSchema,
  ...agentsSchema,
  ...authSchema,
  ...integrationsSchema,
  ...devicesSchema,
  ...usersSchema,
  ...telemetrySchema,
  ...billingSchema,
  ...storeSchema,
  ...mediaSchema,
  ...socialSchema,
  ...backupsSchema,
  ...fashionSchema,
  ...feedbackSchema,
  ...desktopReleasesSchema,
});


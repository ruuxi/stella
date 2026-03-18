import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "transient connector cleanup",
  { minutes: 5 },
  internal.channels.transient_data.purgeExpired,
  { maxBatches: 10 },
);
crons.interval(
  "transient cleanup failure retention sweep",
  { hours: 12 },
  internal.channels.transient_data.purgeExpiredCleanupFailures,
  { maxBatches: 10 },
);
crons.interval("thread lifecycle sweep", { hours: 24 }, internal.data.threads.sweepThreadLifecycle, {});

crons.interval(
  "rescue orphaned remote turns",
  { seconds: 60 },
  internal.channels.connector_delivery.rescueOrphanedTurns,
  {},
);

crons.interval(
  "secret encryption key rotation sweep",
  { hours: 6 },
  internal.data.secrets_rotation.rotateEncryptedMaterial,
  {
    batchSize: 100,
    maxBatches: 5,
  },
);

crons.interval(
  "managed model price sync",
  { hours: 24 },
  internal.billing.syncManagedModelPricesFromModelsDev,
  {},
);

export default crons;

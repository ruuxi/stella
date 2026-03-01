import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("bridge wake tick", { minutes: 1 }, internal.channels.bridge.bridgeWakeTick);
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
crons.interval(
  "ephemeral tool event cleanup",
  { minutes: 5 },
  internal.events.purgeExpiredEphemeralToolEvents,
  { maxBatches: 10 },
);
crons.interval("thread lifecycle sweep", { hours: 24 }, internal.data.threads.sweepThreadLifecycle, {});

crons.cron(
  "cleanup inactive cloud devices",
  "0 5 * * *",
  internal.agent.cloud_device_cleanup.cleanupInactive,
  {},
);

export default crons;

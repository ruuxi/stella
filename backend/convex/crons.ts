import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("heartbeat tick", { minutes: 1 }, internal.scheduling.heartbeat.tick);
crons.interval("cron jobs tick", { minutes: 1 }, internal.scheduling.cron_jobs.tick);
crons.interval("bridge wake tick", { minutes: 1 }, internal.channels.bridge.bridgeWakeTick);
crons.interval("device presence sweep", { minutes: 2 }, internal.agent.device_resolver.markStaleOffline);
crons.interval("thread lifecycle sweep", { hours: 24 }, internal.data.threads.sweepThreadLifecycle, {});

crons.cron(
  "cleanup inactive cloud devices",
  "0 5 * * *",
  internal.agent.cloud_device_cleanup.cleanupInactive,
  {},
);

export default crons;


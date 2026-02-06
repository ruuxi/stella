import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("decay memories", { hourUTC: 4, minuteUTC: 0 }, internal.memory.decayMemories);
crons.interval("heartbeat tick", { minutes: 1 }, internal.heartbeat.tick);
crons.interval("cron jobs tick", { minutes: 1 }, internal.cron_jobs.tick);

export default crons;

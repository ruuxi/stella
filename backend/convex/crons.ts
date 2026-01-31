import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("decay memories", { hourUTC: 4, minuteUTC: 0 }, internal.memory.decayMemories);

export default crons;

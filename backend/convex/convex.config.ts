import { defineApp } from "convex/server";
import betterAuth from "./betterAuth/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import r2 from "@convex-dev/r2/convex.config.js";
import resend from "@convex-dev/resend/convex.config";

const app = defineApp();

app.use(betterAuth);
app.use(rateLimiter);
app.use(r2);
app.use(resend);

export default app;

import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { corsPreflightHandler } from "./http_shared/cors";

// Route modules
import { registerConnectorWebhookRoutes } from "./http_routes/connectors";
import { registerGameRoutes } from "./http_routes/games";
import { registerMediaRoutes } from "./http_routes/media";
import { registerMobileRoutes } from "./http_routes/mobile";

import { registerMusicRoutes } from "./http_routes/music";
import { registerSkillRoutes } from "./http_routes/skills";
import { registerSpeechToTextRoutes } from "./http_routes/speech_to_text";
import { registerStripeRoutes } from "./http_routes/stripe";
import { registerSynthesisRoutes } from "./http_routes/synthesis";
import { registerDashboardPlanRoutes } from "./http_routes/dashboard_plan";
import { registerVoiceRoutes } from "./http_routes/voice";

// Stella provider endpoints
import {
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_MODELS_PATH,
  stellaProviderChatCompletions,
  stellaProviderModels,
  stellaProviderOptions,
} from "./stella_provider";

const http = httpRouter();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

authComponent.registerRoutes(http, createAuth, { cors: true });

// ---------------------------------------------------------------------------
// Feature Routes
// ---------------------------------------------------------------------------

registerSynthesisRoutes(http);
registerDashboardPlanRoutes(http);
registerSpeechToTextRoutes(http);
registerSkillRoutes(http);
registerConnectorWebhookRoutes(http);
registerMusicRoutes(http);
registerMediaRoutes(http);
registerMobileRoutes(http);
registerVoiceRoutes(http);

registerStripeRoutes(http);
registerGameRoutes(http);

// ---------------------------------------------------------------------------
// Stella provider endpoints
// ---------------------------------------------------------------------------

const stellaModelsOptionsHandler = httpAction(async (_ctx, request) =>
  corsPreflightHandler(request),
);

http.route({
  path: STELLA_MODELS_PATH,
  method: "OPTIONS",
  handler: stellaModelsOptionsHandler,
});
http.route({
  path: STELLA_MODELS_PATH,
  method: "GET",
  handler: stellaProviderModels,
});

const stellaChatOptionsHandler = httpAction(async (_ctx, request) =>
  stellaProviderOptions(request),
);

http.route({
  path: STELLA_CHAT_COMPLETIONS_PATH,
  method: "OPTIONS",
  handler: stellaChatOptionsHandler,
});
http.route({
  path: STELLA_CHAT_COMPLETIONS_PATH,
  method: "POST",
  handler: stellaProviderChatCompletions,
});

export default http;


import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { corsPreflightHandler } from "./http_shared/cors";

// Route modules
import { registerConnectorWebhookRoutes } from "./http_routes/connectors";
import { registerSynthesisRoutes } from "./http_routes/synthesis";
import { registerSpeechToTextRoutes } from "./http_routes/speech_to_text";
import { registerSkillRoutes } from "./http_routes/skills";
import { registerMusicRoutes } from "./http_routes/music";
import { registerVoiceRoutes } from "./http_routes/voice";

// Managed AI endpoint
import { managedExecution } from "./managed_execution";

const http = httpRouter();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

authComponent.registerRoutes(http, createAuth, { cors: true });

// ---------------------------------------------------------------------------
// Feature Routes
// ---------------------------------------------------------------------------

registerSynthesisRoutes(http);
registerSpeechToTextRoutes(http);
registerSkillRoutes(http);
registerConnectorWebhookRoutes(http);
registerMusicRoutes(http);
registerVoiceRoutes(http);

// ---------------------------------------------------------------------------
// Stella managed AI endpoint for desktop runtime and managed frontend requests
// ---------------------------------------------------------------------------

const proxyOptionsHandler = httpAction(async (_ctx, request) =>
  corsPreflightHandler(request),
);

// Managed model inference API
http.route({ path: "/api/managed-ai/chat/completions", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/managed-ai/chat/completions", method: "POST", handler: managedExecution });

export default http;

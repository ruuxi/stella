import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { corsPreflightHandler } from "./http_shared/cors";

// Route modules
import { registerConnectorWebhookRoutes } from "./http_routes/connectors";
import { registerSynthesisRoutes } from "./http_routes/synthesis";
import { registerSpeechToTextRoutes } from "./http_routes/speech_to_text";
import { registerSeedMemoryRoutes } from "./http_routes/seed_memories";
import { registerSkillRoutes } from "./http_routes/skills";
import { registerMusicRoutes } from "./http_routes/music";
import { registerVoiceRoutes } from "./http_routes/voice";

// Managed AI proxy
import { llmProxy } from "./ai_proxy";

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
registerSeedMemoryRoutes(http);
registerSkillRoutes(http);
registerConnectorWebhookRoutes(http);
registerMusicRoutes(http);
registerVoiceRoutes(http);

// ---------------------------------------------------------------------------
// Stella managed AI proxy for desktop runtime and managed frontend requests
// ---------------------------------------------------------------------------

const proxyOptionsHandler = httpAction(async (_ctx, request) =>
  corsPreflightHandler(request),
);

// Managed LLM reverse proxy
http.route({ path: "/api/ai/llm-proxy", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/llm-proxy", method: "POST", handler: llmProxy });
http.route({ pathPrefix: "/api/ai/llm-proxy/", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ pathPrefix: "/api/ai/llm-proxy/", method: "POST", handler: llmProxy });

export default http;

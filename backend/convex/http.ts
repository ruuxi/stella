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

// AI proxy (already extracted)
import { proxyChat, proxyEmbed, proxySearch, llmProxy } from "./ai_proxy";

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
// Stella AI Proxy — thin LLM/embed/search proxy for desktop local runtime
// ---------------------------------------------------------------------------

const proxyOptionsHandler = httpAction(async (_ctx, request) =>
  corsPreflightHandler(request),
);

http.route({ path: "/api/ai/proxy", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/proxy", method: "POST", handler: proxyChat });

http.route({ path: "/api/ai/embed", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/embed", method: "POST", handler: proxyEmbed });

http.route({ path: "/api/ai/search", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/search", method: "POST", handler: proxySearch });

// Transparent LLM reverse proxy for local agent runtime
http.route({ pathPrefix: "/api/ai/llm-proxy/", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ pathPrefix: "/api/ai/llm-proxy/", method: "POST", handler: llmProxy });

export default http;

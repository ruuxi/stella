import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { corsPreflightHandler } from "./http_shared/cors";

// Route modules
import { registerConnectorWebhookRoutes } from "./http_routes/connectors";
import { registerMediaRoutes } from "./http_routes/media";
import { registerMobileRoutes } from "./http_routes/mobile";

import { registerMusicRoutes } from "./http_routes/music";
import { registerStripeRoutes } from "./http_routes/stripe";
import { registerSynthesisRoutes } from "./http_routes/synthesis";
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
registerConnectorWebhookRoutes(http);
registerMusicRoutes(http);
registerMediaRoutes(http);
registerMobileRoutes(http);
registerVoiceRoutes(http);

registerStripeRoutes(http);

// ---------------------------------------------------------------------------
// Static assets (vCard, etc.)
// ---------------------------------------------------------------------------

const STELLA_VCARD =
  `BEGIN:VCARD\r\n` +
  `VERSION:3.0\r\n` +
  `FN:Stella\r\n` +
  `TEL;TYPE=CELL:+12052490578\r\n` +
  `NOTE:Your AI assistant — text me anytime.\r\n` +
  `END:VCARD`;

http.route({
  path: "/stella.vcf",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(STELLA_VCARD, {
      status: 200,
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": 'attachment; filename="Stella.vcf"',
        "Cache-Control": "public, max-age=86400",
      },
    });
  }),
});

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

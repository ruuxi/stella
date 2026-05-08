import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { corsPreflightHandler } from "./http_shared/cors";

// Route modules
import { registerAdminRoutes } from "./http_routes/admin";
import { registerConnectorWebhookRoutes } from "./http_routes/connectors";
import { registerBackupRoutes } from "./http_routes/backups";
import { registerDesktopReleaseRoutes } from "./http_routes/desktop_releases";
import { registerMediaRoutes } from "./http_routes/media";
import { registerMobileRoutes } from "./http_routes/mobile";
import { registerPetRoutes } from "./http_routes/pets";

import { registerMusicRoutes } from "./http_routes/music";
import { registerStripeRoutes } from "./http_routes/stripe";
import { registerSynthesisRoutes } from "./http_routes/synthesis";
import { registerVoiceRoutes } from "./http_routes/voice";
import { registerDictationRoutes } from "./http_routes/dictation";

// Stella provider endpoints
import {
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_MODELS_PATH,
  STELLA_RUNTIME_PATH,
  stellaProviderChatCompletions,
  stellaProviderModels,
  stellaProviderOptions,
  stellaProviderRuntime,
} from "./stella_provider";

const http = httpRouter();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

authComponent.registerRoutes(http, createAuth, { cors: true });

// ---------------------------------------------------------------------------
// Feature Routes
// ---------------------------------------------------------------------------

registerAdminRoutes(http);
registerSynthesisRoutes(http);
registerConnectorWebhookRoutes(http);
registerBackupRoutes(http);
registerDesktopReleaseRoutes(http);
registerMusicRoutes(http);
registerMediaRoutes(http);
registerMobileRoutes(http);
registerPetRoutes(http);
registerVoiceRoutes(http);
registerDictationRoutes(http);

registerStripeRoutes(http);

// ---------------------------------------------------------------------------
// Static assets (vCard, etc.)
// ---------------------------------------------------------------------------

http.route({
  path: "/stella.vcf",
  method: "GET",
  handler: httpAction(async () => {
    const phone = process.env.LINQ_FROM_NUMBER ?? "";
    const vcard =
      `BEGIN:VCARD\r\n` +
      `VERSION:3.0\r\n` +
      `FN:Stella\r\n` +
      `TEL;TYPE=CELL:${phone}\r\n` +
      `NOTE:Your AI assistant — text me anytime.\r\n` +
      `END:VCARD`;
    return new Response(vcard, {
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

const stellaRuntimeOptionsHandler = httpAction(async (_ctx, request) =>
  stellaProviderOptions(request),
);

http.route({
  path: STELLA_RUNTIME_PATH,
  method: "OPTIONS",
  handler: stellaRuntimeOptionsHandler,
});
http.route({
  path: STELLA_RUNTIME_PATH,
  method: "POST",
  handler: stellaProviderRuntime,
});

export default http;

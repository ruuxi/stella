/**
 * Discovery Module (DEPRECATED)
 * 
 * Discovery now runs locally on the Electron client for privacy:
 * - AI inference is proxied through /api/discovery/chat (stateless)
 * - Tools are executed locally on the user's device
 * - CORE_MEMORY.MD is stored locally at ~/.stellar/state/
 * - Only the welcome message is saved to the database via /api/discovery/complete
 * 
 * See:
 * - frontend/electron/local-host/discovery.ts for the local discovery service
 * - backend/convex/http.ts for the /api/discovery/* endpoints
 * 
 * This file is kept for reference but the action is no longer exported.
 */

// The prompts are still used by the HTTP endpoints in http.ts
export {
  buildDiscoveryBrowserPrompt,
  buildDiscoveryDevPrompt,
  buildDiscoveryCommsPrompt,
  buildDiscoveryAppsPrompt,
  CORE_MEMORY_SYNTHESIS_PROMPT,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
} from "./prompts";

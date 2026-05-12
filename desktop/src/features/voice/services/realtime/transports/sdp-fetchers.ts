/**
 * Helpers for building SdpAnswerFetcher functions used by the WebRTC
 * transport. Providers compose these into the right shape for their
 * auth flow without each one having to repeat the same fetch boilerplate.
 *
 * Two flavours so far:
 *   - bearerSdpFetcher: POST SDP to a public endpoint with
 *     `Authorization: Bearer <secret>`. Used by OpenAI Realtime and by
 *     Inworld's WebRTC SDP endpoint (which accepts the same Bearer
 *     shape).
 *   - stellaProxiedSdpFetcher: POST SDP to a Stella backend SDP-proxy
 *     route with the renderer's normal Convex auth. The backend forwards
 *     the offer to the upstream provider using its org-side API key, so
 *     no org secret ever reaches the renderer.
 */

import { createServiceRequest } from "@/infra/http/service-request";
import type { SdpAnswerFetcher } from "./types";

/** POST SDP to a public endpoint using a Bearer token. */
export const bearerSdpFetcher =
  (endpoint: string, bearerToken: string): SdpAnswerFetcher =>
  async (sdpOffer) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/sdp",
      },
      body: sdpOffer,
    });
    if (!response.ok) {
      throw new Error(
        `SDP negotiation failed through Stella proxy: ${response.status}`,
      );
    }
    return response.text();
  };

/**
 * POST SDP to a Stella backend route using the user's normal Convex auth.
 * The backend proxies the offer to the upstream voice provider (e.g.
 * Inworld) so the org key never enters the renderer.
 */
export const stellaProxiedSdpFetcher =
  (path: string): SdpAnswerFetcher =>
  async (sdpOffer) => {
    const { endpoint, headers } = await createServiceRequest(path, {
      "Content-Type": "application/sdp",
    });
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: sdpOffer,
    });
    if (!response.ok) {
      throw new Error(
        `SDP negotiation failed: ${response.status} ${await response.text()}`,
      );
    }
    return response.text();
  };

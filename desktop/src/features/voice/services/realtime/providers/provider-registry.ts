/**
 * Provider registry — picks the right {token fetcher, transport factory}
 * pair based on the user's `realtimeVoice.provider` preference.
 *
 * The session class doesn't know which providers exist or how their
 * tokens are minted; it just calls `createRealtimeTransport(ctx)` and
 * gets back a ready-to-connect transport.
 */

import { coerceRealtimeVoiceProvider } from "../../../../../../../runtime/contracts/local-preferences";
import { inworldProvider } from "./inworld-provider";
import { openaiProvider } from "./openai-provider";
import { stellaProvider } from "./stella-provider";
import { xaiProvider } from "./xai-provider";
import type {
  ProviderModule,
  ProviderTokenContext,
  RealtimeProviderKey,
  VoiceSessionToken,
} from "./types";
import type { RealtimeTransport } from "../transports/types";

const PROVIDERS: Record<RealtimeProviderKey, ProviderModule> = {
  stella: stellaProvider,
  openai: openaiProvider,
  xai: xaiProvider,
  inworld: inworldProvider,
};

export async function resolveActiveProvider(): Promise<RealtimeProviderKey> {
  const prefs = await window.electronAPI?.system
    ?.getLocalModelPreferences?.()
    .catch(() => null);
  return coerceRealtimeVoiceProvider(prefs?.realtimeVoice?.provider ?? "");
}

export async function createRealtimeTransport(
  ctx: ProviderTokenContext,
): Promise<{
  transport: RealtimeTransport;
  token: VoiceSessionToken;
  providerKey: RealtimeProviderKey;
}> {
  const providerKey = await resolveActiveProvider();
  const provider = PROVIDERS[providerKey];
  const token = await provider.fetchToken(ctx);
  const transport = provider.createTransport(token, ctx);
  return { transport, token, providerKey };
}

export type { ProviderTokenContext, VoiceSessionToken } from "./types";

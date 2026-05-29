import {
  MOBILE_BRIDGE_EVENT_CHANNELS,
  MOBILE_BRIDGE_REQUEST_CHANNELS,
} from "./capabilities.js";

type MobileBridgeRequestChannel =
  (typeof MOBILE_BRIDGE_REQUEST_CHANNELS)[number];
type MobileBridgeEventChannel = (typeof MOBILE_BRIDGE_EVENT_CHANNELS)[number];

const MOBILE_BRIDGE_REQUEST_CHANNEL_SET = new Set<string>(
  MOBILE_BRIDGE_REQUEST_CHANNELS,
);

const MOBILE_BRIDGE_EVENT_CHANNEL_SET = new Set<string>(
  MOBILE_BRIDGE_EVENT_CHANNELS,
);

export const isMobileBridgeRequestChannel = (
  channel: string,
): channel is MobileBridgeRequestChannel =>
  MOBILE_BRIDGE_REQUEST_CHANNEL_SET.has(channel);

export const isMobileBridgeEventChannel = (
  channel: string,
): channel is MobileBridgeEventChannel =>
  MOBILE_BRIDGE_EVENT_CHANNEL_SET.has(channel);

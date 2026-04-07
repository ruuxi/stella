export const MOBILE_BRIDGE_REQUEST_CHANNELS = [
  "ui:getState",
  "ui:setState",
  "app:setReady",
  "app:hardResetLocalState",
  "chatContext:get",
  "miniBridge:request",
  "theme:listInstalled",
  "voice:persistTranscript",
  "voice:orchestratorChat",
  "voice:webSearch",
  "voice:getRuntimeState",
  "agent:healthCheck",
  "agent:getActiveRun",
  "agent:getAppSessionStartedAt",
  "agent:startChat",
  "agent:cancelChat",
  "agent:resume",
  "selfmod:revert",
  "selfmod:lastFeature",
  "selfmod:recentFeatures",
  "device:getId",
  "host:configurePiRuntime",
  "preferences:getSyncMode",
  "preferences:setSyncMode",
  "preferences:syncLocalModelPreferences",
  "app:resetLocalMessages",
  "credential:submit",
  "credential:cancel",
  "discovery:coreMemoryExists",
  "discovery:knowledgeExists",
  "discovery:collectBrowserData",
  "discovery:detectPreferredBrowser",
  "discovery:listBrowserProfiles",
  "discovery:writeCoreMemory",
  "discovery:writeKnowledge",
  "discovery:collectAllSignals",
  "projects:list",
  "projects:start",
  "projects:stop",
  "schedule:listCronJobs",
  "schedule:listHeartbeats",
  "schedule:listConversationEvents",
  "schedule:getConversationEventCount",
  "store:listLocalFeatures",
  "store:listFeatureBatches",
  "store:createReleaseDraft",
  "store:publishRelease",
  "store:listPackages",
  "store:getPackage",
  "store:listReleases",
  "store:getRelease",
  "store:listInstalledMods",
  "store:installRelease",
  "store:uninstallMod",
  "localChat:getOrCreateDefaultConversationId",
  "localChat:listEvents",
  "localChat:getEventCount",
  "localChat:appendEvent",
  "localChat:listSyncMessages",
  "localChat:getSyncCheckpoint",
  "localChat:setSyncCheckpoint",
  "socialSessions:getStatus",
] as const;

export type MobileBridgeRequestChannel =
  (typeof MOBILE_BRIDGE_REQUEST_CHANNELS)[number];

const MOBILE_BRIDGE_REQUEST_CHANNEL_SET = new Set<string>(
  MOBILE_BRIDGE_REQUEST_CHANNELS,
);

export const MOBILE_BRIDGE_EVENT_CHANNELS = [
  "display:update",
  "ui:state",
  "chatContext:updated",
  "miniBridge:update",
  "theme:change",
  "voice:runtimeState",
  "agent:event",
  "agent:selfModHmrState",
  "credential:request",
  "projects:changed",
  "schedule:updated",
  "localChat:updated",
] as const;

export type MobileBridgeEventChannel =
  (typeof MOBILE_BRIDGE_EVENT_CHANNELS)[number];

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

export const isMobileBridgeChannel = (channel: string) =>
  isMobileBridgeRequestChannel(channel) || isMobileBridgeEventChannel(channel);

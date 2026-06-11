import {
  IPC_AGENT_CANCEL_CHAT,
  IPC_AGENT_EVENT,
  IPC_AGENT_GET_ACTIVE_RUN,
  IPC_AGENT_GET_SESSION_STARTED_AT,
  IPC_AGENT_HEALTH_CHECK,
  IPC_AGENT_RESUME,
  IPC_AGENT_SELF_MOD_HMR_STATE,
  IPC_AGENT_SEND_INPUT,
  IPC_AGENT_START_CHAT,
  IPC_APP_HARD_RESET,
  IPC_APP_RESET_MESSAGES,
  IPC_APP_SET_READY,
  IPC_AUTH_GET_CONVEX_TOKEN,
  IPC_AUTH_GET_SESSION,
  IPC_AUTH_RUNTIME_REFRESH_COMPLETE,
  IPC_AUTH_RUNTIME_REFRESH_REQUESTED,
  IPC_AUTH_SET_STATE,
  IPC_AUTH_SIGN_IN_ANONYMOUS,
  IPC_AUTH_SIGN_OUT,
  IPC_BROWSER_BRIDGE_STATUS,
  IPC_BROWSER_FETCH_JSON,
  IPC_BROWSER_FETCH_TEXT,
  IPC_CHAT_CONTEXT_GET,
  IPC_CHAT_CONTEXT_UPDATED,
  IPC_CREDENTIAL_CANCEL,
  IPC_CREDENTIAL_REQUEST,
  IPC_CREDENTIAL_SUBMIT,
  IPC_DEVICE_GET_ID,
  IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
  IPC_DISCOVERY_COLLECT_BROWSER_DATA,
  IPC_DISCOVERY_CORE_MEMORY_EXISTS,
  IPC_DISCOVERY_DETECT_PREFERRED_BROWSER,
  IPC_DISCOVERY_KNOWLEDGE_EXISTS,
  IPC_DISCOVERY_LIST_BROWSER_PROFILES,
  IPC_DISCOVERY_WRITE_CORE_MEMORY,
  IPC_DISCOVERY_WRITE_KNOWLEDGE,
  IPC_DISPLAY_LIST_CANVAS_HTML,
  IPC_DISPLAY_LIST_OPEN_PANEL_REPORTS,
  IPC_DISPLAY_MARK_OPEN_PANEL_REPORT_OPENED,
  IPC_DISPLAY_READ_FILE,
  IPC_DISPLAY_TRASH_FORCE_DELETE,
  IPC_DISPLAY_TRASH_LIST,
  IPC_DISPLAY_UPDATE,
  IPC_HOST_CONFIGURE_RUNTIME,
  IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID,
  IPC_LOCAL_CHAT_GET_EVENT_COUNT,
  IPC_LOCAL_CHAT_GET_OR_CREATE_ID,
  IPC_LOCAL_CHAT_GET_SYNC_CHECKPOINT,
  IPC_LOCAL_CHAT_LIST_ACTIVITY,
  IPC_LOCAL_CHAT_LIST_EVENTS,
  IPC_LOCAL_CHAT_LIST_FILES,
  IPC_LOCAL_CHAT_LIST_MESSAGES,
  IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE,
  IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES,
  IPC_LOCAL_CHAT_PERSIST_WELCOME,
  IPC_LOCAL_CHAT_SET_SYNC_CHECKPOINT,
  IPC_LOCAL_CHAT_SYNC_MESSAGES,
  IPC_LOCAL_CHAT_UPDATED,
  IPC_LLM_CREDENTIALS_DELETE,
  IPC_LLM_CREDENTIALS_DELETE_OAUTH,
  IPC_LLM_CREDENTIALS_LIST,
  IPC_LLM_CREDENTIALS_LIST_OAUTH,
  IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS,
  IPC_LLM_CREDENTIALS_LOGIN_OAUTH,
  IPC_LLM_CREDENTIALS_SAVE,
  IPC_MEDIA_GET_DIR,
  IPC_MEDIA_SAVE_OUTPUT,
  IPC_MINI_BRIDGE_REQUEST,
  IPC_MINI_BRIDGE_UPDATE,
  IPC_OFFICE_PREVIEW_LIST,
  IPC_OFFICE_PREVIEW_START,
  IPC_ONBOARDING_SYNTHESIZE,
  IPC_PERMISSIONS_GET_STATUS,
  IPC_PERMISSIONS_OPEN_SETTINGS,
  IPC_PREFERENCES_GET_MODELS,
  IPC_PREFERENCES_GET_SYNC_MODE,
  IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS,
  IPC_PREFERENCES_LIST_CODEX_MODELS,
  IPC_PREFERENCES_SET_MODELS,
  IPC_PREFERENCES_SET_SYNC_MODE,
  IPC_SCHEDULE_GET_EVENT_COUNT,
  IPC_SCHEDULE_LIST_CONVERSATION_EVENTS,
  IPC_SCHEDULE_LIST_CRON_JOBS,
  IPC_SCHEDULE_LIST_HEARTBEATS,
  IPC_SCHEDULE_UPDATED,
  IPC_SELFMOD_APPLY,
  IPC_SELFMOD_LAST_COMMIT,
  IPC_SELFMOD_RECENT_COMMITS,
  IPC_SELFMOD_REVERT,
  IPC_SOCIAL_SESSIONS_CREATE,
  IPC_SOCIAL_SESSIONS_GET_STATUS,
  IPC_SOCIAL_SESSIONS_QUEUE_TURN,
  IPC_SOCIAL_SESSIONS_UPDATE_STATUS,
  IPC_STORE_GET_PACKAGE,
  IPC_STORE_GET_RELEASE,
  IPC_STORE_INSTALL_FROM_BLUEPRINT,
  IPC_STORE_LIST_INSTALLED,
  IPC_STORE_LIST_PACKAGES,
  IPC_STORE_LIST_RELEASES,
  IPC_STORE_READ_FEATURE_SNAPSHOT,
  IPC_STORE_UNINSTALL,
  IPC_THEME_LIST_INSTALLED,
  IPC_UI_GET_STATE,
  IPC_UI_SET_STATE,
  IPC_UI_STATE,
  IPC_UI_STATE_KV_APPLY,
  IPC_UI_STATE_KV_CHANGED,
  IPC_UI_STATE_KV_CLEAR,
  IPC_VOICE_GET_RUNTIME_STATE,
  IPC_VOICE_ORCHESTRATOR_CHAT,
  IPC_VOICE_PERSIST_TRANSCRIPT,
  IPC_VOICE_RUNTIME_STATE,
  IPC_VOICE_WEB_SEARCH,
} from "../../../src/shared/contracts/ipc-channels.js";

export type MobileBridgeCapabilityMode =
  | "remote-request"
  | "remote-event"
  | "native"
  | "noop"
  | "unsupported";

export type MobileBridgeRequestTransport = "invoke" | "send";

export type MobileBridgeRequestCapability = {
  mode: "remote-request";
  path: string;
  channel: string;
  transport: MobileBridgeRequestTransport;
};

export type MobileBridgeEventCapability = {
  mode: "remote-event";
  path: string;
  channel: string;
};

export type MobileBridgeLocalCapability = {
  mode: Exclude<MobileBridgeCapabilityMode, "remote-request" | "remote-event">;
  path: string;
  reason: string;
};

export type MobileBridgeCapability =
  | MobileBridgeRequestCapability
  | MobileBridgeEventCapability
  | MobileBridgeLocalCapability;

export type MobileBridgeCapabilityManifest = {
  version: 1;
  capabilities: MobileBridgeCapability[];
};

const invoke = (
  path: string,
  channel: string,
): MobileBridgeRequestCapability => ({
  mode: "remote-request",
  path,
  channel,
  transport: "invoke",
});

const send = (
  path: string,
  channel: string,
): MobileBridgeRequestCapability => ({
  mode: "remote-request",
  path,
  channel,
  transport: "send",
});

const event = (path: string, channel: string): MobileBridgeEventCapability => ({
  mode: "remote-event",
  path,
  channel,
});

const noop = (path: string, reason: string): MobileBridgeLocalCapability => ({
  mode: "noop",
  path,
  reason,
});

const native = (path: string, reason: string): MobileBridgeLocalCapability => ({
  mode: "native",
  path,
  reason,
});

const unsupported = (
  path: string,
  reason: string,
): MobileBridgeLocalCapability => ({
  mode: "unsupported",
  path,
  reason,
});

export const MOBILE_BRIDGE_CAPABILITIES = [
  noop("window.minimize", "The phone does not own desktop window chrome."),
  noop("window.maximize", "The phone does not own desktop window chrome."),
  noop("window.close", "The phone does not own desktop window chrome."),
  noop("window.show", "Mobile already hosts the visible WebView surface."),
  noop(
    "window.setNativeButtonsVisible",
    "Native traffic-light buttons are desktop-only chrome.",
  ),
  unsupported(
    "window.setMiniAlwaysOnTop",
    "Mini-window pinning is desktop-window state.",
  ),
  unsupported(
    "capture.screenshot",
    "Mobile WebView taps should not trigger raw desktop screenshots.",
  ),
  unsupported(
    "capture.submitRegionSelection",
    "Desktop region capture needs desktop pointer geometry.",
  ),
  unsupported(
    "capture.submitRegionClick",
    "Desktop region capture needs desktop pointer geometry.",
  ),
  unsupported(
    "capture.getWindowCapture",
    "Desktop window capture needs desktop pointer geometry.",
  ),
  unsupported(
    "capture.pageDataUrl",
    "Renderer page snapshots are not meaningful inside the phone WebView.",
  ),
  native("system.openExternal", "External links open through the phone shell."),
  noop("system.showItemInFolder", "Finder/Explorer reveal is desktop-only."),
  unsupported(
    "projects.pickDirectory",
    "Directory picking needs a desktop-native picker.",
  ),

  event("display.onUpdate", IPC_DISPLAY_UPDATE),
  invoke("display.readFile", IPC_DISPLAY_READ_FILE),
  invoke("display.listCanvasHtml", IPC_DISPLAY_LIST_CANVAS_HTML),
  invoke("display.listOpenPanelReports", IPC_DISPLAY_LIST_OPEN_PANEL_REPORTS),
  invoke(
    "display.markOpenPanelReportOpened",
    IPC_DISPLAY_MARK_OPEN_PANEL_REPORT_OPENED,
  ),
  invoke("display.listTrash", IPC_DISPLAY_TRASH_LIST),
  invoke("display.forceDeleteTrash", IPC_DISPLAY_TRASH_FORCE_DELETE),

  invoke("officePreview.list", IPC_OFFICE_PREVIEW_LIST),
  invoke("officePreview.start", IPC_OFFICE_PREVIEW_START),
  noop(
    "officePreview.onUpdate",
    "Mobile receives office preview updates through scoped list polling.",
  ),

  invoke("ui.getState", IPC_UI_GET_STATE),
  invoke("ui.setState", IPC_UI_SET_STATE),
  event("ui.onState", IPC_UI_STATE),
  send("ui.setAppReady", IPC_APP_SET_READY),
  invoke("ui.hardReset", IPC_APP_HARD_RESET),

  invoke("capture.getContext", IPC_CHAT_CONTEXT_GET),
  event("capture.onContext", IPC_CHAT_CONTEXT_UPDATED),

  invoke("mini.request", IPC_MINI_BRIDGE_REQUEST),
  event("mini.onUpdate", IPC_MINI_BRIDGE_UPDATE),

  invoke("theme.listInstalled", IPC_THEME_LIST_INSTALLED),

  send("uiState.apply", IPC_UI_STATE_KV_APPLY),
  send("uiState.clear", IPC_UI_STATE_KV_CLEAR),
  event("uiState.onChanged", IPC_UI_STATE_KV_CHANGED),

  send("voice.persistTranscript", IPC_VOICE_PERSIST_TRANSCRIPT),
  invoke("voice.orchestratorChat", IPC_VOICE_ORCHESTRATOR_CHAT),
  invoke("voice.webSearch", IPC_VOICE_WEB_SEARCH),
  invoke("voice.getRuntimeState", IPC_VOICE_GET_RUNTIME_STATE),
  event("voice.onRuntimeState", IPC_VOICE_RUNTIME_STATE),

  invoke("agent.healthCheck", IPC_AGENT_HEALTH_CHECK),
  invoke("agent.getActiveRun", IPC_AGENT_GET_ACTIVE_RUN),
  invoke("agent.getAppSessionStartedAt", IPC_AGENT_GET_SESSION_STARTED_AT),
  invoke("agent.startChat", IPC_AGENT_START_CHAT),
  invoke("agent.sendInput", IPC_AGENT_SEND_INPUT),
  send("agent.cancelChat", IPC_AGENT_CANCEL_CHAT),
  invoke("agent.resumeConversationExecution", IPC_AGENT_RESUME),
  invoke("agent.resumeStream", IPC_AGENT_RESUME),
  event("agent.onStream", IPC_AGENT_EVENT),
  event("agent.onSelfModHmrState", IPC_AGENT_SELF_MOD_HMR_STATE),
  invoke("agent.selfModApply", IPC_SELFMOD_APPLY),
  invoke("agent.selfModRevert", IPC_SELFMOD_REVERT),
  invoke("agent.getLastSelfModCommit", IPC_SELFMOD_LAST_COMMIT),
  invoke("agent.listSelfModCommits", IPC_SELFMOD_RECENT_COMMITS),

  invoke("system.getDeviceId", IPC_DEVICE_GET_ID),
  invoke("system.startPhoneAccessSession", "phoneAccess:startSession"),
  invoke("system.stopPhoneAccessSession", "phoneAccess:stopSession"),
  invoke("system.configurePiRuntime", IPC_HOST_CONFIGURE_RUNTIME),
  invoke("system.setAuthState", IPC_AUTH_SET_STATE),
  invoke("system.getAuthSession", IPC_AUTH_GET_SESSION),
  invoke("system.signInAnonymous", IPC_AUTH_SIGN_IN_ANONYMOUS),
  invoke("system.signOutAuth", IPC_AUTH_SIGN_OUT),
  invoke("system.getConvexAuthToken", IPC_AUTH_GET_CONVEX_TOKEN),
  invoke(
    "system.completeRuntimeAuthRefresh",
    IPC_AUTH_RUNTIME_REFRESH_COMPLETE,
  ),
  event(
    "system.onRuntimeAuthRefreshRequested",
    IPC_AUTH_RUNTIME_REFRESH_REQUESTED,
  ),
  invoke("system.getLocalSyncMode", IPC_PREFERENCES_GET_SYNC_MODE),
  invoke("system.setLocalSyncMode", IPC_PREFERENCES_SET_SYNC_MODE),
  invoke("system.getPermissionStatus", IPC_PERMISSIONS_GET_STATUS),
  invoke("system.openPermissionSettings", IPC_PERMISSIONS_OPEN_SETTINGS),
  invoke("system.getLocalModelPreferences", IPC_PREFERENCES_GET_MODELS),
  invoke("system.setLocalModelPreferences", IPC_PREFERENCES_SET_MODELS),
  invoke("system.syncLocalModelPreferences", IPC_PREFERENCES_SET_MODELS),
  invoke("system.listCodexModels", IPC_PREFERENCES_LIST_CODEX_MODELS),
  invoke(
    "system.listClaudeCodeModels",
    IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS,
  ),
  invoke("system.listLlmCredentials", IPC_LLM_CREDENTIALS_LIST),
  invoke(
    "system.listLlmOAuthProviders",
    IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS,
  ),
  invoke("system.listLlmOAuthCredentials", IPC_LLM_CREDENTIALS_LIST_OAUTH),
  invoke("system.loginLlmOAuthCredential", IPC_LLM_CREDENTIALS_LOGIN_OAUTH),
  invoke("system.deleteLlmOAuthCredential", IPC_LLM_CREDENTIALS_DELETE_OAUTH),
  invoke("system.saveLlmCredential", IPC_LLM_CREDENTIALS_SAVE),
  invoke("system.deleteLlmCredential", IPC_LLM_CREDENTIALS_DELETE),
  invoke("system.resetMessages", IPC_APP_RESET_MESSAGES),
  event("system.onCredentialRequest", IPC_CREDENTIAL_REQUEST),
  invoke("system.submitCredential", IPC_CREDENTIAL_SUBMIT),
  invoke("system.cancelCredential", IPC_CREDENTIAL_CANCEL),

  invoke("onboarding.synthesizeCoreMemory", IPC_ONBOARDING_SYNTHESIZE),

  invoke("discovery.checkCoreMemoryExists", IPC_DISCOVERY_CORE_MEMORY_EXISTS),
  invoke("discovery.checkKnowledgeExists", IPC_DISCOVERY_KNOWLEDGE_EXISTS),
  invoke("discovery.collectData", IPC_DISCOVERY_COLLECT_BROWSER_DATA),
  invoke("discovery.detectPreferred", IPC_DISCOVERY_DETECT_PREFERRED_BROWSER),
  invoke("discovery.listProfiles", IPC_DISCOVERY_LIST_BROWSER_PROFILES),
  invoke("discovery.writeCoreMemory", IPC_DISCOVERY_WRITE_CORE_MEMORY),
  invoke("discovery.writeKnowledge", IPC_DISCOVERY_WRITE_KNOWLEDGE),
  invoke("discovery.collectAllSignals", IPC_DISCOVERY_COLLECT_ALL_SIGNALS),

  event("browser.onBridgeStatus", IPC_BROWSER_BRIDGE_STATUS),
  invoke("browser.fetchJson", IPC_BROWSER_FETCH_JSON),
  invoke("browser.fetchText", IPC_BROWSER_FETCH_TEXT),

  invoke("media.saveOutput", IPC_MEDIA_SAVE_OUTPUT),
  invoke("media.getStellaMediaDir", IPC_MEDIA_GET_DIR),

  invoke("schedule.listCronJobs", IPC_SCHEDULE_LIST_CRON_JOBS),
  invoke("schedule.listHeartbeats", IPC_SCHEDULE_LIST_HEARTBEATS),
  invoke(
    "schedule.listConversationEvents",
    IPC_SCHEDULE_LIST_CONVERSATION_EVENTS,
  ),
  invoke("schedule.getConversationEventCount", IPC_SCHEDULE_GET_EVENT_COUNT),
  event("schedule.onUpdated", IPC_SCHEDULE_UPDATED),

  invoke("store.readFeatureSnapshot", IPC_STORE_READ_FEATURE_SNAPSHOT),
  invoke("store.listPackages", IPC_STORE_LIST_PACKAGES),
  invoke("store.getPackage", IPC_STORE_GET_PACKAGE),
  invoke("store.listPackageReleases", IPC_STORE_LIST_RELEASES),
  invoke("store.getPackageRelease", IPC_STORE_GET_RELEASE),
  invoke("store.listInstalledMods", IPC_STORE_LIST_INSTALLED),
  invoke("store.installFromBlueprint", IPC_STORE_INSTALL_FROM_BLUEPRINT),
  invoke("store.installRelease", IPC_STORE_INSTALL_FROM_BLUEPRINT),
  invoke("store.uninstallPackage", IPC_STORE_UNINSTALL),

  invoke(
    "localChat.getOrCreateDefaultConversationId",
    IPC_LOCAL_CHAT_GET_OR_CREATE_ID,
  ),
  invoke(
    "localChat.createNewDefaultConversationId",
    IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID,
  ),
  invoke("localChat.listEvents", IPC_LOCAL_CHAT_LIST_EVENTS),
  invoke("localChat.listMessages", IPC_LOCAL_CHAT_LIST_MESSAGES),
  invoke("localChat.listMessagesBefore", IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE),
  invoke("localChat.listActivity", IPC_LOCAL_CHAT_LIST_ACTIVITY),
  invoke("localChat.listFiles", IPC_LOCAL_CHAT_LIST_FILES),
  invoke("localChat.getEventCount", IPC_LOCAL_CHAT_GET_EVENT_COUNT),
  invoke("localChat.persistDiscoveryWelcome", IPC_LOCAL_CHAT_PERSIST_WELCOME),
  invoke("localChat.listSyncMessages", IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES),
  invoke("localChat.syncMessages", IPC_LOCAL_CHAT_SYNC_MESSAGES),
  invoke("localChat.getSyncCheckpoint", IPC_LOCAL_CHAT_GET_SYNC_CHECKPOINT),
  invoke("localChat.setSyncCheckpoint", IPC_LOCAL_CHAT_SET_SYNC_CHECKPOINT),
  event("localChat.onUpdated", IPC_LOCAL_CHAT_UPDATED),

  invoke("socialSessions.create", IPC_SOCIAL_SESSIONS_CREATE),
  invoke("socialSessions.updateStatus", IPC_SOCIAL_SESSIONS_UPDATE_STATUS),
  invoke("socialSessions.queueTurn", IPC_SOCIAL_SESSIONS_QUEUE_TURN),
  invoke("socialSessions.getStatus", IPC_SOCIAL_SESSIONS_GET_STATUS),
] as const satisfies readonly MobileBridgeCapability[];

export const MOBILE_BRIDGE_REQUEST_CAPABILITIES =
  MOBILE_BRIDGE_CAPABILITIES.filter(
    (capability): capability is MobileBridgeRequestCapability =>
      capability.mode === "remote-request",
  );

export const MOBILE_BRIDGE_EVENT_CAPABILITIES =
  MOBILE_BRIDGE_CAPABILITIES.filter(
    (capability): capability is MobileBridgeEventCapability =>
      capability.mode === "remote-event",
  );

export const MOBILE_BRIDGE_REQUEST_CHANNELS =
  MOBILE_BRIDGE_REQUEST_CAPABILITIES.map((capability) => capability.channel);

export const MOBILE_BRIDGE_EVENT_CHANNELS =
  MOBILE_BRIDGE_EVENT_CAPABILITIES.map((capability) => capability.channel);

export const buildMobileBridgeCapabilityManifest =
  (): MobileBridgeCapabilityManifest => ({
    version: 1,
    capabilities: [...MOBILE_BRIDGE_CAPABILITIES],
  });

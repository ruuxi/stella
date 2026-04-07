/**
 * IPC Channel Constants
 *
 * Single source of truth for all Electron IPC channel names used between the
 * main process (electron/ipc/*.ts, electron/preload.ts) and the renderer.
 *
 * Import these constants instead of using raw channel-name strings so that:
 *   1. Typos are caught at compile time.
 *   2. Renaming a channel is a single-point change.
 *   3. "Find all references" works across both processes.
 *
 * Naming convention:  `<namespace>:<verb|noun>` in camelCase.
 */

// ── Window ──────────────────────────────────────────────────────────────────

export const IPC_WINDOW_MINIMIZE = "window:minimize" as const;
export const IPC_WINDOW_MAXIMIZE = "window:maximize" as const;
export const IPC_WINDOW_CLOSE = "window:close" as const;
export const IPC_WINDOW_IS_MAXIMIZED = "window:isMaximized" as const;
export const IPC_WINDOW_SHOW = "window:show" as const;

// ── Display ─────────────────────────────────────────────────────────────────

export const IPC_DISPLAY_UPDATE = "display:update" as const;
export const IPC_OFFICE_PREVIEW_LIST = "officePreview:list" as const;
export const IPC_OFFICE_PREVIEW_UPDATE = "officePreview:update" as const;

// ── UI State ────────────────────────────────────────────────────────────────

export const IPC_UI_GET_STATE = "ui:getState" as const;
export const IPC_UI_SET_STATE = "ui:setState" as const;
export const IPC_UI_STATE = "ui:state" as const;
export const IPC_APP_SET_READY = "app:setReady" as const;
export const IPC_APP_RELOAD = "app:reload" as const;
export const IPC_APP_HARD_RESET = "app:hardResetLocalState" as const;
export const IPC_MORPH_START = "morph:start" as const;
export const IPC_MORPH_COMPLETE = "morph:complete" as const;

// ── Capture ─────────────────────────────────────────────────────────────────

export const IPC_CHAT_CONTEXT_GET = "chatContext:get" as const;
export const IPC_CHAT_CONTEXT_UPDATED = "chatContext:updated" as const;
export const IPC_CHAT_CONTEXT_ACK = "chatContext:ack" as const;
export const IPC_CHAT_CONTEXT_REMOVE_SCREENSHOT = "chatContext:removeScreenshot" as const;
export const IPC_SCREENSHOT_CAPTURE = "screenshot:capture" as const;
export const IPC_REGION_SELECT = "region:select" as const;
export const IPC_REGION_CLICK = "region:click" as const;
export const IPC_REGION_GET_WINDOW_CAPTURE = "region:getWindowCapture" as const;
export const IPC_REGION_CANCEL = "region:cancel" as const;
export const IPC_REGION_RESET = "region:reset" as const;
export const IPC_CAPTURE_PAGE_DATA_URL = "capture:pageDataUrl" as const;

// ── Radial ──────────────────────────────────────────────────────────────────

export const IPC_RADIAL_SHOW = "radial:show" as const;
export const IPC_RADIAL_HIDE = "radial:hide" as const;
export const IPC_RADIAL_ANIM_DONE = "radial:animDone" as const;
export const IPC_RADIAL_CURSOR = "radial:cursor" as const;
export const IPC_RADIAL_WINDOW_BOUNDS = "radial:windowBounds" as const;

// ── Overlay ─────────────────────────────────────────────────────────────────

export const IPC_OVERLAY_SET_INTERACTIVE = "overlay:setInteractive" as const;
export const IPC_OVERLAY_START_REGION_CAPTURE = "overlay:startRegionCapture" as const;
export const IPC_OVERLAY_END_REGION_CAPTURE = "overlay:endRegionCapture" as const;
export const IPC_OVERLAY_SHOW_MINI = "overlay:showMini" as const;
export const IPC_OVERLAY_HIDE_MINI = "overlay:hideMini" as const;
export const IPC_OVERLAY_RESTORE_MINI = "overlay:restoreMini" as const;
export const IPC_OVERLAY_SHOW_VOICE = "overlay:showVoice" as const;
export const IPC_OVERLAY_HIDE_VOICE = "overlay:hideVoice" as const;
export const IPC_OVERLAY_DISPLAY_CHANGE = "overlay:displayChange" as const;
export const IPC_OVERLAY_MORPH_FORWARD = "overlay:morphForward" as const;
export const IPC_OVERLAY_MORPH_BOUNDS = "overlay:morphBounds" as const;
export const IPC_OVERLAY_MORPH_REVERSE = "overlay:morphReverse" as const;
export const IPC_OVERLAY_MORPH_END = "overlay:morphEnd" as const;
export const IPC_OVERLAY_MORPH_STATE = "overlay:morphState" as const;
export const IPC_OVERLAY_MORPH_READY = "overlay:morphReady" as const;
export const IPC_OVERLAY_MORPH_DONE = "overlay:morphDone" as const;

// ── Mini ────────────────────────────────────────────────────────────────────

export const IPC_MINI_VISIBILITY = "mini:visibility" as const;
export const IPC_MINI_DISMISS_PREVIEW = "mini:dismissPreview" as const;
export const IPC_MINI_BRIDGE_REQUEST = "miniBridge:request" as const;
export const IPC_MINI_BRIDGE_UPDATE = "miniBridge:update" as const;
export const IPC_MINI_BRIDGE_RESPONSE = "miniBridge:response" as const;
export const IPC_MINI_BRIDGE_READY = "miniBridge:ready" as const;

// ── Theme ───────────────────────────────────────────────────────────────────

export const IPC_THEME_CHANGE = "theme:change" as const;
export const IPC_THEME_BROADCAST = "theme:broadcast" as const;
export const IPC_THEME_LIST_INSTALLED = "theme:listInstalled" as const;

// ── Voice ───────────────────────────────────────────────────────────────────

export const IPC_VOICE_PERSIST_TRANSCRIPT = "voice:persistTranscript" as const;
export const IPC_VOICE_ORCHESTRATOR_CHAT = "voice:orchestratorChat" as const;
export const IPC_VOICE_WEB_SEARCH = "voice:webSearch" as const;
export const IPC_VOICE_GET_RUNTIME_STATE = "voice:getRuntimeState" as const;
export const IPC_VOICE_RUNTIME_STATE = "voice:runtimeState" as const;
export const IPC_VOICE_GET_WAKE_WORD_STATE = "voice:getWakeWordState" as const;
export const IPC_VOICE_WAKE_WORD_STATE = "voice:wakeWordState" as const;
export const IPC_VOICE_WAKE_WORD_DETECTED = "voice:wakeWordDetected" as const;
export const IPC_VOICE_WAKE_WORD_AUDIO = "voice:wakeWordAudio" as const;
export const IPC_VOICE_RTC_SET_SHORTCUT = "voice-rtc:setShortcut" as const;

// ── Agent ───────────────────────────────────────────────────────────────────

export const IPC_AGENT_HEALTH_CHECK = "agent:healthCheck" as const;
export const IPC_AGENT_GET_ACTIVE_RUN = "agent:getActiveRun" as const;
export const IPC_AGENT_GET_SESSION_STARTED_AT = "agent:getAppSessionStartedAt" as const;
export const IPC_AGENT_START_CHAT = "agent:startChat" as const;
export const IPC_AGENT_CANCEL_CHAT = "agent:cancelChat" as const;
export const IPC_AGENT_RESUME = "agent:resume" as const;
export const IPC_AGENT_EVENT = "agent:event" as const;
export const IPC_AGENT_SELF_MOD_HMR_STATE = "agent:selfModHmrState" as const;
export const IPC_SELFMOD_REVERT = "selfmod:revert" as const;
export const IPC_SELFMOD_LAST_FEATURE = "selfmod:lastFeature" as const;
export const IPC_SELFMOD_RECENT_FEATURES = "selfmod:recentFeatures" as const;
export const IPC_DEVTEST_TRIGGER_VITE_ERROR = "devtest:triggerViteError" as const;
export const IPC_DEVTEST_FIX_VITE_ERROR = "devtest:fixViteError" as const;

// ── System ──────────────────────────────────────────────────────────────────

export const IPC_DEVICE_GET_ID = "device:getId" as const;
export const IPC_PHONE_ACCESS_START = "phoneAccess:startSession" as const;
export const IPC_PHONE_ACCESS_STOP = "phoneAccess:stopSession" as const;
export const IPC_HOST_CONFIGURE_RUNTIME = "host:configurePiRuntime" as const;
export const IPC_AUTH_SET_STATE = "auth:setState" as const;
export const IPC_HOST_SET_CLOUD_SYNC = "host:setCloudSyncEnabled" as const;
export const IPC_AUTH_CALLBACK = "auth:callback" as const;
export const IPC_SYSTEM_OPEN_FDA = "system:openFullDiskAccess" as const;
export const IPC_PERMISSIONS_GET_STATUS = "permissions:getStatus" as const;
export const IPC_PERMISSIONS_OPEN_SETTINGS = "permissions:openSettings" as const;
export const IPC_SHELL_OPEN_EXTERNAL = "shell:openExternal" as const;
export const IPC_SHELL_SHOW_IN_FOLDER = "shell:showItemInFolder" as const;
export const IPC_SHELL_KILL_BY_PORT = "shell:killByPort" as const;
export const IPC_PREFERENCES_GET_SYNC_MODE = "preferences:getSyncMode" as const;
export const IPC_PREFERENCES_SET_SYNC_MODE = "preferences:setSyncMode" as const;
export const IPC_PREFERENCES_SYNC_MODELS = "preferences:syncLocalModelPreferences" as const;
export const IPC_PREFERENCES_GET_RADIAL_TRIGGER = "preferences:getRadialTrigger" as const;
export const IPC_PREFERENCES_SET_RADIAL_TRIGGER = "preferences:setRadialTrigger" as const;
export const IPC_LLM_CREDENTIALS_LIST = "llmCredentials:list" as const;
export const IPC_LLM_CREDENTIALS_SAVE = "llmCredentials:save" as const;
export const IPC_LLM_CREDENTIALS_DELETE = "llmCredentials:delete" as const;
export const IPC_APP_RESET_MESSAGES = "app:resetLocalMessages" as const;
export const IPC_CREDENTIAL_REQUEST = "credential:request" as const;
export const IPC_CREDENTIAL_SUBMIT = "credential:submit" as const;
export const IPC_CREDENTIAL_CANCEL = "credential:cancel" as const;

// ── Onboarding ──────────────────────────────────────────────────────────────

export const IPC_ONBOARDING_SYNTHESIZE = "onboarding:synthesizeCoreMemory" as const;

// ── Discovery ───────────────────────────────────────────────────────────────

export const IPC_DISCOVERY_CORE_MEMORY_EXISTS =
  "discovery:coreMemoryExists" as const;
export const IPC_DISCOVERY_KNOWLEDGE_EXISTS =
  "discovery:knowledgeExists" as const;
export const IPC_DISCOVERY_COLLECT_BROWSER_DATA =
  "discovery:collectBrowserData" as const;
export const IPC_DISCOVERY_DETECT_PREFERRED_BROWSER =
  "discovery:detectPreferredBrowser" as const;
export const IPC_DISCOVERY_LIST_BROWSER_PROFILES =
  "discovery:listBrowserProfiles" as const;
export const IPC_DISCOVERY_WRITE_CORE_MEMORY =
  "discovery:writeCoreMemory" as const;
export const IPC_DISCOVERY_WRITE_KNOWLEDGE =
  "discovery:writeKnowledge" as const;
export const IPC_DISCOVERY_COLLECT_ALL_SIGNALS =
  "discovery:collectAllSignals" as const;

// ── Browser ─────────────────────────────────────────────────────────────────

export const IPC_BROWSER_FETCH_JSON = "browser:fetchJson" as const;
export const IPC_BROWSER_FETCH_TEXT = "browser:fetchText" as const;
export const IPC_BROWSER_BRIDGE_STATUS = "browser:bridgeStatus" as const;

// ── Media ───────────────────────────────────────────────────────────────────

export const IPC_MEDIA_SAVE_OUTPUT = "media:saveOutput" as const;
export const IPC_MEDIA_GET_DIR = "media:getStellaMediaDir" as const;

// ── Projects ────────────────────────────────────────────────────────────────

export const IPC_PROJECTS_LIST = "projects:list" as const;
export const IPC_PROJECTS_PICK_DIRECTORY = "projects:pickDirectory" as const;
export const IPC_PROJECTS_START = "projects:start" as const;
export const IPC_PROJECTS_STOP = "projects:stop" as const;
export const IPC_PROJECTS_CHANGED = "projects:changed" as const;

// ── Schedule ────────────────────────────────────────────────────────────────

export const IPC_SCHEDULE_LIST_CRON_JOBS = "schedule:listCronJobs" as const;
export const IPC_SCHEDULE_LIST_HEARTBEATS = "schedule:listHeartbeats" as const;
export const IPC_SCHEDULE_LIST_CONVERSATION_EVENTS = "schedule:listConversationEvents" as const;
export const IPC_SCHEDULE_GET_EVENT_COUNT = "schedule:getConversationEventCount" as const;
export const IPC_SCHEDULE_UPDATED = "schedule:updated" as const;

// ── Store ───────────────────────────────────────────────────────────────────

export const IPC_STORE_LIST_LOCAL_FEATURES = "store:listLocalFeatures" as const;
export const IPC_STORE_LIST_FEATURE_BATCHES = "store:listFeatureBatches" as const;
export const IPC_STORE_CREATE_RELEASE_DRAFT = "store:createReleaseDraft" as const;
export const IPC_STORE_PUBLISH_RELEASE = "store:publishRelease" as const;
export const IPC_STORE_LIST_PACKAGES = "store:listPackages" as const;
export const IPC_STORE_GET_PACKAGE = "store:getPackage" as const;
export const IPC_STORE_LIST_RELEASES = "store:listReleases" as const;
export const IPC_STORE_GET_RELEASE = "store:getRelease" as const;
export const IPC_STORE_LIST_INSTALLED = "store:listInstalledMods" as const;
export const IPC_STORE_INSTALL_RELEASE = "store:installRelease" as const;
export const IPC_STORE_UNINSTALL = "store:uninstallMod" as const;

// ── Local Chat ──────────────────────────────────────────────────────────────

export const IPC_LOCAL_CHAT_GET_OR_CREATE_ID = "localChat:getOrCreateDefaultConversationId" as const;
export const IPC_LOCAL_CHAT_LIST_EVENTS = "localChat:listEvents" as const;
export const IPC_LOCAL_CHAT_GET_EVENT_COUNT = "localChat:getEventCount" as const;
export const IPC_LOCAL_CHAT_PERSIST_WELCOME = "localChat:persistDiscoveryWelcome" as const;
export const IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES = "localChat:listSyncMessages" as const;
export const IPC_LOCAL_CHAT_GET_SYNC_CHECKPOINT = "localChat:getSyncCheckpoint" as const;
export const IPC_LOCAL_CHAT_SET_SYNC_CHECKPOINT = "localChat:setSyncCheckpoint" as const;
export const IPC_LOCAL_CHAT_UPDATED = "localChat:updated" as const;

// ── Social Sessions ─────────────────────────────────────────────────────────

export const IPC_SOCIAL_SESSIONS_CREATE = "socialSessions:create" as const;
export const IPC_SOCIAL_SESSIONS_UPDATE_STATUS = "socialSessions:updateStatus" as const;
export const IPC_SOCIAL_SESSIONS_QUEUE_TURN = "socialSessions:queueTurn" as const;
export const IPC_SOCIAL_SESSIONS_GET_STATUS = "socialSessions:getStatus" as const;

// ── Google Workspace ────────────────────────────────────────────────────────

export const IPC_GOOGLE_WORKSPACE_AUTH_STATUS = "googleWorkspace:authStatus" as const;
export const IPC_GOOGLE_WORKSPACE_CONNECT = "googleWorkspace:connect" as const;
export const IPC_GOOGLE_WORKSPACE_DISCONNECT = "googleWorkspace:disconnect" as const;
export const IPC_GOOGLE_WORKSPACE_AUTH_REQUIRED = "googleWorkspace:authRequired" as const;

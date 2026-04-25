export type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes";

export type RadialWedge = "capture" | "chat" | "add" | "voice" | "dismiss";

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type ChatContextFile = {
  name: string;
  size: number;
  mimeType: string;
  dataUrl: string;
};

export type ChatContext = {
  window: {
    title: string;
    app: string;
    bounds: WindowBounds;
  } | null;
  windowContextEnabled?: boolean;
  browserUrl?: string | null;
  selectedText?: string | null;
  regionScreenshots?: {
    dataUrl: string;
    width: number;
    height: number;
  }[];
  files?: ChatContextFile[];
  capturePending?: boolean;
  windowScreenshot?: {
    dataUrl: string;
    width: number;
    height: number;
  } | null;
};

export type ChatContextUpdate = {
  context: ChatContext | null;
  version: number;
};

export type MiniBridgeEventRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: Record<string, unknown>;
};

export type MiniBridgeSnapshot = {
  conversationId: string | null;
  events: MiniBridgeEventRecord[];
  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
};

export type MiniBridgeRequest =
  | {
      type: "query:snapshot";
      conversationId: string | null;
    }
  | {
      type: "mutation:sendMessage";
      conversationId: string;
      text: string;
      selectedText: string | null;
      chatContext: ChatContext | null;
    }
  | {
      type: "mutation:cancelStream";
      conversationId: string;
    };

export type MiniBridgeResponse =
  | {
      type: "query:snapshot";
      snapshot: MiniBridgeSnapshot;
    }
  | {
      type: "mutation:sendMessage";
      accepted: boolean;
    }
  | {
      type: "mutation:cancelStream";
      accepted: boolean;
    }
  | {
      type: "error";
      message: string;
    };

export type MiniBridgeRequestEnvelope = {
  requestId: string;
  request: MiniBridgeRequest;
};

export type MiniBridgeResponseEnvelope = {
  requestId: string;
  response: MiniBridgeResponse;
};

export type MiniBridgeUpdate = {
  type: "snapshot";
  snapshot: MiniBridgeSnapshot;
};

export type BrowserType = "chrome" | "edge" | "brave" | "arc" | "opera" | "vivaldi";

export type DomainVisit = {
  domain: string;
  visits: number;
};

export type DomainDetail = {
  title: string;
  url: string;
  visitCount: number;
};

export type ClusterKeyword = {
  keyword: string;
  score: number;
  lastVisit: number;
};

export type BrowserData = {
  browser: BrowserType | null;
  clusterDomains: string[];
  recentDomains: DomainVisit[];
  allTimeDomains: DomainVisit[];
  domainDetails: Record<string, DomainDetail[]>;
  clusterKeywords: ClusterKeyword[];
};

export type BrowserDataResult = {
  data: BrowserData | null;
  formatted: string | null;
  error?: string;
};

export type PreferredBrowserProfile = {
  browser: BrowserType | null;
  profile: string | null;
};

export type BrowserProfile = {
  id: string;
  name: string;
};

export type DevProject = {
  name: string;
  path: string;
  lastActivity: number;
};

export type CommandFrequency = {
  command: string;
  count: number;
};

export type ShellAnalysis = {
  topCommands: CommandFrequency[];
  projectPaths: string[];
  toolsUsed: string[];
};

export type DiscoveredApp = {
  name: string;
  executablePath: string;
  source: "running" | "recent";
  lastUsed?: number;
};

export type AllUserSignals = {
  browser: BrowserData;
  devProjects: DevProject[];
  shell: ShellAnalysis;
  apps: DiscoveredApp[];
};

export type AllUserSignalsResult = {
  data: AllUserSignals | null;
  formatted: string | null;
  formattedSections?: Partial<Record<DiscoveryCategory, string>> | null;
  error?: string;
};

/**
 * Lightweight summary of one recent self-mod commit, surfaced to runtime
 * diagnostic UIs (Vite error overlay revert buttons, crash surface, taint
 * monitor toast). Each entry corresponds to a single git commit; the
 * `featureId` field carries the full commit hash so callers can pass it
 * straight back into revert APIs.
 */
export type SelfModFeatureSummary = {
  featureId: string;
  name: string;
  description: string;
  latestCommit: string;
  latestTimestampMs: number;
  commitCount: number;
  tainted?: boolean;
  taintedFiles?: string[];
};

/**
 * A flat record of one Stella self-modification commit, surfaced to the
 * Store UI without grouping by feature. Subjects are agent-authored
 * descriptions of the change (no `[feature:<id>]` tag).
 *
 * `conversationId` is the optional `Stella-Conversation:` trailer added by
 * the runtime; the Store agent uses it later to recover the user-intent
 * context that produced the change.
 */
export type LocalGitCommitRecord = {
  commitHash: string;
  shortHash: string;
  subject: string;
  body: string;
  timestampMs: number;
  fileCount: number;
  files: string[];
  conversationId?: string;
  /**
   * True when the commit was created via the legacy `[feature:<id>, +N]`
   * tagged-commit path. Lets the Store UI hide internals while still
   * surfacing the user-facing description.
   */
  legacyFeatureTagged?: boolean;
  /** Optional package id this commit belongs to (only set for installs/updates). */
  packageId?: string;
};

export type StoreReleaseBlueprintFile = {
  path: string;
  changeType: "create" | "update" | "delete";
  deleted?: boolean;
  referenceContentBase64?: string;
};

/**
 * One commit's worth of change material inside a published release
 * blueprint. `batchId` is a deterministic per-commit identifier (e.g.
 * `commit:<short>`) — a holdover from the legacy feature/batch scheme
 * that keeps existing consumers (manifest schema, blueprint apply
 * guidance) addressable without forking.
 */
export type StoreReleaseBlueprintBatch = {
  batchId: string;
  ordinal: number;
  commitHash: string;
  files: string[];
  subject: string;
  body: string;
  patch: string;
};

export type StoreReleaseArtifact = {
  kind: "self_mod_blueprint";
  schemaVersion: 1;
  manifest: StoreReleaseManifest;
  applyGuidance: string;
  batches: StoreReleaseBlueprintBatch[];
  files: StoreReleaseBlueprintFile[];
};

export type StoreReleaseManifest = {
  packageId: string;
  releaseNumber: number;
  displayName: string;
  description: string;
  releaseNotes?: string;
  /** Per-commit batch ids embedded in the artifact (e.g. `commit:<short>`). */
  batchIds: string[];
  commitHashes: string[];
  files: string[];
  createdAt: number;
};

export type StorePackageRecord = {
  packageId: string;
  displayName: string;
  description: string;
  latestReleaseNumber: number;
  createdAt: number;
  updatedAt: number;
};

export type StorePackageReleaseRecord = {
  packageId: string;
  releaseNumber: number;
  manifest: StoreReleaseManifest;
  storageKey: string;
  artifactUrl?: string | null;
  createdAt: number;
};

export type InstalledStoreModRecord = {
  installId: string;
  packageId: string;
  releaseNumber: number;
  applyCommitHashes: string[];
  state: "installed" | "uninstalled";
  createdAt: number;
  updatedAt: number;
};

export type SelfModHmrPhase =
  | "idle"
  | "paused"
  | "morph-forward"
  | "applying"
  | "reloading"
  | "morph-reverse";

export type SelfModHmrState = {
  phase: SelfModHmrPhase;
  paused: boolean;
  requiresFullReload: boolean;
};

export type AgentHealth =
  | {
      ready: true;
      runnerVersion?: string;
      engine?: string;
    }
  | {
      ready: false;
      reason?: string;
      engine?: string;
    };

export type LocalLlmCredentialSummary = {
  provider: string;
  label: string;
  status: "active";
  updatedAt: number;
};

export type LocalCronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type LocalCronPayload =
  | { kind: "systemEvent"; text: string; agentType?: string; deliver?: boolean }
  | { kind: "agentTurn"; message: string; agentType?: string; deliver?: boolean };

export type LocalHeartbeatActiveHours = {
  start: string;
  end: string;
  timezone?: string;
};

export type LocalCronJobRecord = {
  id: string;
  conversationId: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: LocalCronSchedule;
  sessionTarget: "main" | "isolated";
  payload: LocalCronPayload;
  deleteAfterRun?: boolean;
  nextRunAtMs: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  lastError?: string;
  lastDurationMs?: number;
  lastOutputPreview?: string;
  createdAt: number;
  updatedAt: number;
};

export type LocalHeartbeatConfigRecord = {
  id: string;
  conversationId: string;
  enabled: boolean;
  intervalMs: number;
  prompt?: string;
  checklist?: string;
  ackMaxChars?: number;
  deliver?: boolean;
  agentType?: string;
  activeHours?: LocalHeartbeatActiveHours;
  targetDeviceId?: string;
  runningAtMs?: number;
  lastRunAtMs?: number;
  nextRunAtMs: number;
  lastStatus?: string;
  lastError?: string;
  lastSentText?: string;
  lastSentAtMs?: number;
  createdAt: number;
  updatedAt: number;
};

export type ScheduledConversationEvent = {
  _id: string;
  conversationId: string;
  timestamp: number;
  type: "assistant_message";
  payload: Record<string, unknown>;
};

export type VoiceRuntimeSnapshot = {
  sessionState: "idle" | "connecting" | "connected" | "error" | "disconnecting";
  isConnected: boolean;
  isSpeaking: boolean;
  isUserSpeaking: boolean;
  micLevel: number;
  outputLevel: number;
};

export type SocialSessionRuntimeRecord = {
  sessionId: string;
  role: "host" | "follower";
  hostDeviceId: string;
  isActiveHost: boolean;
  localFolderPath: string;
  localFolderName: string;
  lastAppliedFileOpOrdinal: number;
  lastObservedTurnOrdinal: number;
};

export type SocialSessionServiceSnapshot = {
  enabled: boolean;
  status: "stopped" | "connecting" | "running" | "error";
  deviceId?: string;
  sessionCount: number;
  sessions: SocialSessionRuntimeRecord[];
  lastError?: string;
  lastSyncAt?: number;
  processingTurnId?: string;
};

export const createEmptySocialSessionServiceSnapshot = (): SocialSessionServiceSnapshot => ({
  enabled: false,
  status: "stopped",
  sessionCount: 0,
  sessions: [],
});

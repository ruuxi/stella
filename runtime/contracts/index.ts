export type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes";

export type RadialWedge = "capture" | "chat" | "add" | "voice" | "dismiss";

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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
  appSelection?: {
    label: string;
    snapshot: string;
    bounds: WindowBounds;
    surface?: string;
    anchor?: {
      kind: string;
      label?: string;
      tag?: string;
      role?: string;
      path?: string;
    };
    source?: {
      filePath?: string;
      lineNumber?: number;
      componentName?: string;
    };
    stack?: string;
  } | null;
  windowContextEnabled?: boolean;
  windowAxTree?: string | null;
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

export type BrowserType =
  | "chrome"
  | "edge"
  | "brave"
  | "arc"
  | "opera"
  | "vivaldi";

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
 * diagnostic UIs (Vite error overlay revert button, crash surface, taint
 * monitor toast). `featureId` carries the full commit hash so callers
 * can pass it straight back into revert APIs.
 *
 * Distinct from `SelfModFeatureSnapshot` below — this one is per-commit
 * and used by the diagnostic surface; the snapshot is the rolling
 * normie-friendly grouping used by the Store side panel.
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
 * One entry in the rolling-window feature snapshot the Store side panel
 * renders. `name` is a normie-friendly 3-7 word phrase the namer LLM
 * produced; `commitHashes` is the LLM's grouping decision used to build the
 * source pack and reference diffs for publishing.
 */
export type SelfModFeatureSnapshotItem = {
  name: string;
  commitHashes: string[];
};

export type SelfModFeatureSnapshot = {
  items: SelfModFeatureSnapshotItem[];
  generatedAt: number;
};

export type StorePackageCategory =
  | "apps-games"
  | "productivity"
  | "customization"
  | "skills-agents"
  | "integrations"
  | "other";

/**
 * One commit's worth of reference diff that the install agent uses as
 * a strong default when implementing the release on a divergent tree.
 * Authored by the publisher's tree; redacted at publish time.
 */
export type StoreReleaseCommit = {
  hash: string;
  subject: string;
  /** Output of `git show -U10 --find-renames --no-color` post-redaction. */
  diff: string;
};

export type StoreReleaseSourceBlob =
  | { kind: "text"; content: string }
  | { kind: "binary"; contentBase64: string };

export type StoreReleaseSourceChange = {
  path: string;
  baseHash: string | null;
  nextHash: string | null;
  /** Touched-path base content; never the full original source tree. */
  base?: StoreReleaseSourceBlob;
  /** Touched-path incoming content; omitted only for deletes/history-only packs. */
  next?: StoreReleaseSourceBlob;
};

export type StoreReleaseSourceChangeSet = {
  schemaVersion: 1;
  baseRevisionId: string;
  parentRevisionIds: string[];
  revisionId: string;
  featureId?: string;
  description?: string;
  changes: StoreReleaseSourceChange[];
};

export type StoreReleaseSourcePack = {
  kind: "stella-source-pack";
  schemaVersion: 1;
  baseRevisionId: string;
  revisionId: string;
  featureId?: string;
  description?: string;
  changeSets: StoreReleaseSourceChangeSet[];
};

export type StoreReleaseSourcePackRef = {
  kind: "r2";
  r2Key: string;
  sha256: string;
  sizeBytes: number;
};

export type StoreReleaseGitObjectType = "blob" | "tree" | "commit";

export type StoreReleaseGitObject = {
  sha: string;
  type: StoreReleaseGitObjectType;
  sizeBytes: number;
};

export type StoreReleaseGitArtifact = {
  kind: "git-object-artifact";
  schemaVersion: 1;
  baseCommit: string;
  featureCommit: string;
  objects: StoreReleaseGitObject[];
  security?: {
    redactedPaths: string[];
    omittedPaths: string[];
    warnings: string[];
  };
};

export type StoreReleaseDiffRef = {
  kind: "r2";
  r2Key: string;
  sha256: string;
  sizeBytes: number;
};

export type StoreReleaseGitObjectUpload = StoreReleaseGitObject & {
  compressedBytes: Uint8Array;
};

export type DesktopReleaseSourcePackRef = {
  kind: "url";
  url: string;
  sha256: string;
  sizeBytes: number;
};

export type DesktopReleaseSourceHistoryRef = {
  kind: "url";
  url: string;
  sha256: string;
  sizeBytes: number;
};

export type StellaReleaseArtifactRef = {
  kind: "native-helpers";
  platform: string;
  /** Pinned manifest for this helper build; avoids drifting to latest. */
  manifestUrl: string;
  manifestSha?: string;
  commit?: string;
  builtAt?: string;
  sourceRevisionId?: string;
  asset: {
    url: string;
    sha256: string;
    sizeBytes: number;
  };
};

/**
 * A published Store release carries a canonical git-object feature commit plus
 * a lightweight listing summary. The sanitized diff is kept for preview,
 * review, and agent fallback when the automatic merge path cannot apply.
 */
export type StoreReleaseArtifact = {
  kind: "blueprint";
  schemaVersion: 2;
  manifest: StoreReleaseManifest;
  blueprintMarkdown: string;
  /** Git-object Store transport for new source-backed installs. */
  gitArtifact?: StoreReleaseGitArtifact;
  /** Sanitized squashed diff for preview, review, and agent fallback. */
  diff?: string;
  /** R2 reference for large sanitized diffs. */
  diffRef?: StoreReleaseDiffRef;
  /** Legacy per-commit reference diffs selected by the publisher's local Store flow. */
  commits?: StoreReleaseCommit[];
};

export type StoreReleaseManifest = {
  packageId: string;
  releaseNumber: number;
  category: StorePackageCategory;
  displayName: string;
  /** Optional store description; omitted on packages published without one. */
  description?: string;
  releaseNotes?: string;
  createdAt: number;
  /** Optional commit hash on the author's tree at publish time. */
  authoredAtCommit?: string;
  iconUrl?: string;
};

export type StorePackageRecord = {
  packageId: string;
  category?: StorePackageCategory;
  tags?: string[];
  displayName: string;
  /** Optional store description; omitted on packages published without one. */
  description?: string;
  latestReleaseNumber: number;
  createdAt: number;
  updatedAt: number;
  iconUrl?: string;
  authorUsername?: string;
  featured?: boolean;
  /**
   * Visibility tier — see backend `store_package_visibility_validator`.
   * Omitted = public (legacy rows + first-publish default).
   */
  visibility?: "public" | "unlisted" | "private";
  /** Total install attempts recorded by the backend. */
  installCount?: number;
};

export type StorePackageReleaseRecord = {
  packageId: string;
  releaseNumber: number;
  manifest: StoreReleaseManifest;
  blueprintMarkdown: string;
  /**
   * Per-commit reference diffs the install agent uses. Stored in R2
   * (`commitsDiffRef`); only present here after on-demand hydration.
   */
  commits?: StoreReleaseCommit[];
  /** R2 reference for the per-commit diff bundle. */
  commitsDiffRef?: StoreReleaseDiffRef;
  gitArtifact?: StoreReleaseGitArtifact;
  /** Squashed diff; stored in R2 (`diffRef`), present only after hydration. */
  diff?: string;
  diffRef?: StoreReleaseDiffRef;
  createdAt: number;
};

/**
 * Persisted record of an installed Store add-on. The install flow
 * records both the local Git commit(s) used for undo and the Stella source
 * revision(s) used to understand which source graph state was installed.
 */
export type StoreInstallRecord = {
  packageId: string;
  releaseNumber: number;
  installCommitHash: string | null;
  installCommitHashes: string[];
  sourceRevisionId: string | null;
  sourceRevisionIds: string[];
  installedAt: number;
};

export type StoreThreadMessage = {
  _id: string;
  role: "user" | "assistant" | "system_event";
  text: string;
  isBlueprint?: boolean;
  denied?: boolean;
  published?: boolean;
  publishedReleaseNumber?: number;
  pending?: boolean;
  attachedFeatureNames?: string[];
  editingBlueprint?: boolean;
  createdAt: number;
};

export type StoreThreadSnapshot = {
  threadId: string;
  messages: StoreThreadMessage[];
};

export type StoreThreadSendInput = {
  text: string;
  attachedFeatureNames?: string[];
  editingBlueprint?: boolean;
};

export type SelfModHmrPhase =
  | "idle"
  | "paused"
  | "morph-forward"
  | "applying"
  | "reloading"
  | "morph-handoff";

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

/**
 * Three-tier cron-fire delivery contract. See
 * `runtime/kernel/shared/scheduling.ts` for the canonical doc-comment.
 */
export type LocalCronPayload =
  | { kind: "notify"; text: string }
  | { kind: "script"; scriptPath: string }
  | { kind: "agent"; prompt: string; agentType?: string };

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
  payload: LocalCronPayload;
  deliver?: boolean;
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

export type LocalCronJobUpdatePatch = {
  name?: string;
  schedule?: LocalCronSchedule;
  payload?: LocalCronPayload;
  conversationId?: string;
  description?: string;
  enabled?: boolean;
  deliver?: boolean;
  deleteAfterRun?: boolean;
};

export type LocalHeartbeatUpsertInput = {
  conversationId: string;
  enabled?: boolean;
  intervalMs?: number;
  prompt?: string;
  checklist?: string;
  ackMaxChars?: number;
  deliver?: boolean;
  agentType?: string;
  activeHours?: LocalHeartbeatActiveHours;
  targetDeviceId?: string;
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

export const createEmptySocialSessionServiceSnapshot =
  (): SocialSessionServiceSnapshot => ({
    enabled: false,
    status: "stopped",
    sessionCount: 0,
    sessions: [],
  });

import type {
  AgentToolApi,
  StoreToolApi,
  ToolContext,
  ToolResult,
} from "./types.js";

const formatResult = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);

const requireStoreApi = (storeApi?: StoreToolApi): StoreToolApi => {
  if (!storeApi) {
    throw new Error("Store publishing is not configured on this device.");
  }
  return storeApi;
};

const requireAgentApi = (agentApi?: AgentToolApi): AgentToolApi => {
  if (!agentApi) {
    throw new Error("Agent orchestration is not configured on this device.");
  }
  return agentApi;
};

const getStorePrompt = (args: Record<string, unknown>) => {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    throw new Error("prompt is required.");
  }
  return prompt;
};

const buildStoreTaskPrompt = (prompt: string, context: ToolContext) =>
  `Help the user assemble and publish a Stella Store release for conversation ${context.conversationId}.

User request:
${prompt}

Instructions:
- Inspect recent self-mod commits with \`StoreListLocalCommits\` and deeper git commands when needed.
- For updates, inspect existing packages/releases with \`StoreListPackages\`, \`StoreGetPackage\`, and \`StoreListPackageReleases\`.
- Confirm with the user via \`askQuestion\` when more than one commit grouping plausibly matches the request, or when displayName/description/release notes need confirmation.
- Once you have a confirmed selection of commit hashes plus package metadata, call \`StorePublishCommits\` to publish.
- Return plain text only: a short summary of what was published, or clearly say if nothing was published and why.`;

export const handleStore = async (
  agentApi: AgentToolApi | undefined,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireAgentApi(agentApi);
  const prompt = getStorePrompt(args);
  const nextAgentDepth = Math.max(0, context.agentDepth ?? 0) + 1;
  const created = await api.createAgent({
    conversationId: context.conversationId,
    description: "Publish to Stella Store",
    prompt: buildStoreTaskPrompt(prompt, context),
    agentType: "store",
    rootRunId: context.rootRunId,
    agentDepth: nextAgentDepth,
    ...(typeof context.maxAgentDepth === "number"
      ? { maxAgentDepth: context.maxAgentDepth }
      : {}),
    parentAgentId: context.cloudAgentId ?? context.agentId,
    storageMode: context.storageMode ?? "local",
  });

  return {
    result:
      "Store agent started. Continue the publish/update flow in that Store conversation.",
    details: { threadId: created.threadId },
  };
};

export const handleStoreListLocalCommits = async (
  storeApi: StoreToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireStoreApi(storeApi);
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(500, Math.floor(args.limit)))
      : undefined;
  const commits = await api.listLocalCommits(limit);
  return { result: formatResult(commits) };
};

export const handleStoreListPackages = async (
  storeApi: StoreToolApi | undefined,
): Promise<ToolResult> => {
  const api = requireStoreApi(storeApi);
  const packages = await api.listPackages();
  return { result: formatResult(packages) };
};

export const handleStoreGetPackage = async (
  storeApi: StoreToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireStoreApi(storeApi);
  const packageId = typeof args.packageId === "string" ? args.packageId.trim() : "";
  if (!packageId) {
    return { error: "packageId is required." };
  }
  const pkg = await api.getPackage(packageId);
  return { result: formatResult(pkg) };
};

export const handleStoreListPackageReleases = async (
  storeApi: StoreToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireStoreApi(storeApi);
  const packageId = typeof args.packageId === "string" ? args.packageId.trim() : "";
  if (!packageId) {
    return { error: "packageId is required." };
  }
  const releases = await api.listPackageReleases(packageId);
  return { result: formatResult(releases) };
};

export const handleStorePublishCommits = async (
  storeApi: StoreToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireStoreApi(storeApi);
  const packageId = typeof args.packageId === "string" ? args.packageId.trim() : "";
  if (!packageId) {
    return { error: "packageId is required." };
  }
  const displayName =
    typeof args.displayName === "string" ? args.displayName.trim() : "";
  if (!displayName) {
    return { error: "displayName is required." };
  }
  const description =
    typeof args.description === "string" ? args.description.trim() : "";
  if (!description) {
    return { error: "description is required." };
  }
  const releaseNotes =
    typeof args.releaseNotes === "string" && args.releaseNotes.trim().length > 0
      ? args.releaseNotes.trim()
      : undefined;
  const commitHashesRaw = Array.isArray(args.commitHashes) ? args.commitHashes : [];
  const commitHashes = commitHashesRaw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (commitHashes.length === 0) {
    return { error: "commitHashes must include at least one commit." };
  }

  try {
    const release = await api.publishCommitsAsRelease({
      packageId,
      commitHashes,
      displayName,
      description,
      ...(releaseNotes ? { releaseNotes } : {}),
    });
    return {
      result: `Published ${release.manifest.displayName} v${release.releaseNumber} to the Stella Store.`,
      details: release,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
};

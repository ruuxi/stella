export type OrchestratorPrimaryRoute =
  | "conversational"
  | "memory"
  | "scheduling"
  | "general"
  | "explore"
  | "browser"
  | "self_mod";

export type RoutingConfidence = "high" | "medium" | "low";

export type OrchestratorRouteDecision = {
  primaryRoute: OrchestratorPrimaryRoute;
  confidence: RoutingConfidence;
  reason: string;
  mustUseTools: boolean;
  mustDelegate: boolean;
  delegateSubagent?: "general" | "explore" | "browser" | "self_mod";
  useRecallMemory: boolean;
  usePreExplore: boolean;
};

type ClassifierInput = {
  text: string;
  hasAttachments?: boolean;
};

const SCHEDULING_RE =
  /\b(remind me|reminder|every (day|week|month|morning|evening|night)|daily|weekly|monthly|each (day|week|month)|at \d{1,2}(:\d{2})?\s?(am|pm)?|cron|heartbeat|set (a )?reminder|schedule (it|this|that))\b/i;

const MEMORY_RE =
  /\b(what did we (talk|discuss|decide)|remember (when|that)|last time|previous conversation|from yesterday|earlier you said|did we decide|we talked about)\b/i;

const PRIOR_CONTEXT_RE =
  /\b(last time|previous|earlier|we discussed|we talked|remember)\b/i;

const SELF_MOD_SCOPE_RE =
  /\b(stella|stella ui|assistant ui|chat ui|your interface|your ui|this interface|canvas panel)\b/i;

const SELF_MOD_ACTION_RE =
  /\b(change|update|modify|redesign|restyle|theme|appearance|layout|color scheme|font|style)\b/i;

const STORE_MOD_RE =
  /\b(install|uninstall|remove)\b.*\b(mod|theme)\b|\b(mod|theme)\b.*\b(install|uninstall|remove)\b/i;

const BROWSER_RE =
  /\b(fill( out)? form|submit form|click|navigate|browse( the)? (site|website|page)|log ?in|sign ?in|sign ?up|take( a)? screenshot|scrape|web automation|playwright|use the browser)\b/i;

const URL_RE = /\bhttps?:\/\/|www\./i;

const EXECUTION_ACTION_RE =
  /\b(open|run|execute|start|create|build|write|edit|update|modify|change|fix|install|uninstall|remove|delete|deploy|refactor|implement|generate|set up|configure|convert|download|upload|compile|test)\b/i;

const READ_DISCOVERY_RE =
  /\b(where (is|are)|find|locate|search|grep|read|inspect|understand|explain|how does|what file|which file|show me (where|how)|look up|research)\b/i;

const CODEBASE_RE =
  /\b(codebase|repo|repository|file|files|function|component|module|project|folder|directory|source|docs?|documentation)\b/i;

const CONVERSATIONAL_RE =
  /\b(hi|hello|hey|thanks|thank you|how are you|good morning|good night|good evening)\b/i;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const compactReason = (value: string) => value.replace(/\s+/g, " ").trim();

const baseDecision = (
  primaryRoute: OrchestratorPrimaryRoute,
  confidence: RoutingConfidence,
  reason: string,
): OrchestratorRouteDecision => {
  const mustDelegate =
    primaryRoute === "general" ||
    primaryRoute === "explore" ||
    primaryRoute === "browser" ||
    primaryRoute === "self_mod";

  return {
    primaryRoute,
    confidence,
    reason: compactReason(reason),
    mustUseTools:
      primaryRoute !== "conversational",
    mustDelegate,
    delegateSubagent: mustDelegate ? primaryRoute : undefined,
    useRecallMemory: false,
    usePreExplore: false,
  };
};

export const classifyOrchestratorIntent = (
  input: ClassifierInput,
): OrchestratorRouteDecision => {
  const normalized = normalize(input.text ?? "");
  const hasAttachments = Boolean(input.hasAttachments);

  if (!normalized) {
    if (hasAttachments) {
      return baseDecision(
        "general",
        "medium",
        "Message contains attachments but no text; route to General for tool-based handling.",
      );
    }
    return baseDecision(
      "conversational",
      "low",
      "No actionable text detected.",
    );
  }

  if (SCHEDULING_RE.test(normalized)) {
    return baseDecision(
      "scheduling",
      "high",
      "Detected reminder/schedule language.",
    );
  }

  if (MEMORY_RE.test(normalized)) {
    return baseDecision(
      "memory",
      "high",
      "Detected prior-conversation recall language.",
    );
  }

  if (STORE_MOD_RE.test(normalized)) {
    return baseDecision(
      "self_mod",
      "high",
      "Detected mod/theme install intent.",
    );
  }

  if (SELF_MOD_SCOPE_RE.test(normalized) && SELF_MOD_ACTION_RE.test(normalized)) {
    return baseDecision(
      "self_mod",
      "high",
      "Detected Stella/UI appearance modification intent.",
    );
  }

  if (BROWSER_RE.test(normalized)) {
    return baseDecision(
      "browser",
      "high",
      "Detected browser interaction/automation intent.",
    );
  }

  if (URL_RE.test(normalized) && /\b(click|fill|submit|log ?in|sign ?in|screenshot|scrape)\b/i.test(normalized)) {
    return baseDecision(
      "browser",
      "medium",
      "Detected website interaction intent with URL.",
    );
  }

  const hasExecutionAction = EXECUTION_ACTION_RE.test(normalized);
  const hasReadDiscovery = READ_DISCOVERY_RE.test(normalized);
  const referencesCodebase = CODEBASE_RE.test(normalized);
  const referencesPriorContext = PRIOR_CONTEXT_RE.test(normalized);

  if (hasExecutionAction) {
    const decision = baseDecision(
      "general",
      "high",
      "Detected execution/change intent that requires tools.",
    );
    decision.useRecallMemory = referencesPriorContext;
    decision.usePreExplore = hasReadDiscovery && referencesCodebase;
    return decision;
  }

  if (hasReadDiscovery) {
    const decision = baseDecision(
      "explore",
      referencesCodebase ? "high" : "medium",
      referencesCodebase
        ? "Detected read-only codebase discovery intent."
        : "Detected read-only discovery/research intent.",
    );
    decision.useRecallMemory = referencesPriorContext;
    return decision;
  }

  if (CONVERSATIONAL_RE.test(normalized) && normalized.length <= 120) {
    return baseDecision(
      "conversational",
      "high",
      "Detected non-action conversational input.",
    );
  }

  return baseDecision(
    "conversational",
    "low",
    "No strong action or routing signal detected.",
  );
};

export const buildRuntimeRouteContext = (
  decision: OrchestratorRouteDecision,
): string => {
  const lines = [
    "# Runtime Route",
    "This route is computed by backend rules for this turn. Treat it as authoritative for intent matching.",
    `primary_route: ${decision.primaryRoute}`,
    `confidence: ${decision.confidence}`,
    `reason: ${decision.reason}`,
    `must_use_tools: ${decision.mustUseTools ? "true" : "false"}`,
    `must_delegate: ${decision.mustDelegate ? "true" : "false"}`,
  ];

  if (decision.delegateSubagent) {
    lines.push(`delegate_subagent: ${decision.delegateSubagent}`);
  }

  lines.push(`use_recall_memory: ${decision.useRecallMemory ? "true" : "false"}`);
  lines.push(`use_pre_explore: ${decision.usePreExplore ? "true" : "false"}`);
  lines.push(
    "If must_delegate=true, call TaskCreate in this turn. Do not return only a capability disclaimer.",
  );

  return lines.join("\n");
};

export const MAX_ACTIVE_RUNTIME_THREADS = 16;
export const RUNTIME_THREAD_REMINDER_INTERVAL_TOKENS = 25_000;

export type RuntimeThreadRecord = {
  conversationId: string;
  threadKey: string;
  agentType: string;
  name: string;
  status: "active" | "evicted";
  createdAt: number;
  lastUsedAt: number;
  summary?: string;
};

export const RUNTIME_THREAD_NAME_POOL = [
  "apollo",
  "ares",
  "artemis",
  "athena",
  "atlas",
  "augustus",
  "aurelia",
  "bacchus",
  "brutus",
  "caesar",
  "calypso",
  "cassius",
  "ceres",
  "cicero",
  "circe",
  "clio",
  "daphne",
  "demeter",
  "diana",
  "electra",
  "euclid",
  "flora",
  "fortuna",
  "gaia",
  "hector",
  "helios",
  "hera",
  "hermes",
  "hestia",
  "hyperion",
  "iris",
  "janus",
  "juno",
  "jupiter",
  "lares",
  "leo",
  "livia",
  "lucius",
  "lyra",
  "mars",
  "mercury",
  "minerva",
  "neptune",
  "nike",
  "nova",
  "odysseus",
  "orion",
  "phoebe",
  "pluto",
  "pollux",
].sort();

export const normalizeRuntimeThreadName = (value: string): string | undefined => {
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const pickAvailableRuntimeThreadName = (
  activeNames: Iterable<string>,
  random = Math.random,
): string => {
  const unavailable = new Set(Array.from(activeNames, (name) => name.toLowerCase()));
  const available = RUNTIME_THREAD_NAME_POOL.filter((name) => !unavailable.has(name));
  const pool = available.length > 0 ? available : [...RUNTIME_THREAD_NAME_POOL];
  const index = Math.max(0, Math.min(pool.length - 1, Math.floor(random() * pool.length)));
  return pool[index]!;
};

export const estimateRuntimeTokens = (value: string): number => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Math.max(1, Math.ceil(trimmed.length / 4)) : 0;
};

const formatAge = (timestamp: number, now: number): string => {
  const ageMs = Math.max(0, now - timestamp);
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
};

export const buildActiveThreadsPrompt = (
  threads: RuntimeThreadRecord[],
  now = Date.now(),
): string => {
  if (threads.length === 0) return "";
  const lines = threads.slice(0, MAX_ACTIVE_RUNTIME_THREADS).map((thread) => {
    const summary = thread.summary?.trim()
      ? ` — ${thread.summary.trim().replace(/\s+/g, " ").slice(0, 180)}`
      : "";
    return `- ${thread.name} (${thread.agentType}, last used ${formatAge(thread.lastUsedAt, now)})${summary}`;
  });
  return `# Active Threads\nReuse a thread with thread_name when continuing related work. Omit thread_name to start a fresh thread and the runtime will assign one.\n${lines.join("\n")}`;
};

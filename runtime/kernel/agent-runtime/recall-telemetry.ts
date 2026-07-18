import { performance } from "node:perf_hooks";

export type RecallTelemetrySourceKind = "file" | "host" | "sql";

export type RecallTelemetrySourceTiming = {
  kind: RecallTelemetrySourceKind;
  calls: number;
  ms: number;
  chars: number;
};

export type RecallTelemetrySeed = {
  /** High-resolution timestamp captured before route resolution. */
  startedAtMs?: number;
  routeMs?: number;
  hostContextMs?: number;
  sourceTimings?: Record<string, RecallTelemetrySourceTiming>;
};

export type RecallTelemetryRecord = {
  version: 1;
  conversationId: string;
  outcome: string;
  engine: "claude-code" | "native" | "unknown";
  modelId: string;
  routeMs: number;
  hostContextMs: number;
  seedSearchMs: number;
  sourceTimings: Record<string, RecallTelemetrySourceTiming>;
  seedChars: number;
  modelCalls: number;
  modelMs: number;
  toolRounds: number;
  assemblyMs: number;
  totalMs: number;
};

const finiteNonNegative = (value: number | undefined): number =>
  Number.isFinite(value) && (value ?? 0) >= 0 ? (value ?? 0) : 0;

const roundedMs = (value: number): number =>
  Math.round(finiteNonNegative(value) * 1_000) / 1_000;

const roundedSourceTiming = (
  timing: RecallTelemetrySourceTiming,
): RecallTelemetrySourceTiming => ({
  kind: timing.kind,
  calls: Math.max(0, Math.floor(timing.calls)),
  ms: roundedMs(timing.ms),
  chars: Math.max(0, Math.floor(timing.chars)),
});

/** Mutable per-lookup collector; only its immutable snapshot is logged. */
export class RecallTelemetryCollector {
  private readonly startedAtMs: number;
  private readonly routeMs: number;
  private readonly hostContextMs: number;
  private readonly sourceTimings: Record<string, RecallTelemetrySourceTiming>;
  private seedSearchMs = 0;
  private seedChars = 0;
  private modelCalls = 0;
  private modelMs = 0;
  private toolRounds = 0;
  private assemblyMs = 0;
  private engine: RecallTelemetryRecord["engine"] = "unknown";
  private modelId = "unknown";

  constructor(seed: RecallTelemetrySeed = {}) {
    this.startedAtMs =
      typeof seed.startedAtMs === "number" &&
      Number.isFinite(seed.startedAtMs) &&
      seed.startedAtMs >= 0
        ? seed.startedAtMs
        : performance.now();
    this.routeMs = finiteNonNegative(seed.routeMs);
    this.hostContextMs = finiteNonNegative(seed.hostContextMs);
    this.sourceTimings = {};
    for (const [name, timing] of Object.entries(seed.sourceTimings ?? {})) {
      this.sourceTimings[name] = roundedSourceTiming(timing);
    }
  }

  setRoute(engine: RecallTelemetryRecord["engine"], modelId: string): void {
    this.engine = engine;
    this.modelId = modelId.trim() || "unknown";
  }

  setSeedSearchMs(ms: number): void {
    this.seedSearchMs = finiteNonNegative(ms);
  }

  setSeedChars(chars: number): void {
    this.seedChars = Math.max(0, Math.floor(chars));
  }

  addAssemblyMs(ms: number): void {
    this.assemblyMs += finiteNonNegative(ms);
  }

  addModelCall(ms = 0): void {
    this.modelCalls += 1;
    this.modelMs += finiteNonNegative(ms);
  }

  addModelRuntimeMs(ms: number): void {
    this.modelMs += finiteNonNegative(ms);
  }

  addToolRound(): void {
    this.toolRounds += 1;
  }

  addSource(
    name: string,
    kind: RecallTelemetrySourceKind,
    ms: number,
    chars = 0,
  ): void {
    const existing = this.sourceTimings[name];
    if (existing) {
      existing.calls += 1;
      existing.ms += finiteNonNegative(ms);
      existing.chars += Math.max(0, Math.floor(chars));
      return;
    }
    this.sourceTimings[name] = {
      kind,
      calls: 1,
      ms: finiteNonNegative(ms),
      chars: Math.max(0, Math.floor(chars)),
    };
  }

  snapshot(conversationId: string, outcome: string): RecallTelemetryRecord {
    return {
      version: 1,
      conversationId,
      outcome,
      engine: this.engine,
      modelId: this.modelId,
      routeMs: roundedMs(this.routeMs),
      hostContextMs: roundedMs(this.hostContextMs),
      seedSearchMs: roundedMs(this.seedSearchMs),
      sourceTimings: Object.fromEntries(
        Object.entries(this.sourceTimings).map(([name, timing]) => [
          name,
          roundedSourceTiming(timing),
        ]),
      ),
      seedChars: this.seedChars,
      modelCalls: this.modelCalls,
      modelMs: roundedMs(this.modelMs),
      toolRounds: this.toolRounds,
      assemblyMs: roundedMs(this.assemblyMs),
      totalMs: roundedMs(performance.now() - this.startedAtMs),
    };
  }
}

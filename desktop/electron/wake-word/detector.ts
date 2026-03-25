/**
 * Wake word detector using onnxruntime-node.
 *
 * Ports the openWakeWord streaming inference pipeline faithfully from Python:
 *   raw audio buffer -> melspectrogram (with context overlap) -> embeddings -> classifier
 *
 * Adds two lightweight gates ahead of the wake-word model:
 *   very-low-volume gate -> heuristic VAD gate -> wake-word inference
 *
 * While the gates are closed we keep only a short raw-audio pre-roll so the
 * first speech chunk can still include a bit of leading silence without paying
 * the full continuous inference cost.
 */

import path from "path";

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;
type OrtSessionOptions = import("onnxruntime-node").InferenceSession.SessionOptions;
type OrtTensor = import("onnxruntime-node").Tensor;

let ortModulePromise: Promise<OrtModule> | null = null;

async function loadOrtModule(): Promise<OrtModule> {
  if (!ortModulePromise) {
    ortModulePromise = import("onnxruntime-node");
  }
  return ortModulePromise;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WakeWordResult {
  detected: boolean;
  score: number;
  vadScore: number;
  frontEnd?: WakeWordFrontEndState;
  vadGate?: WakeWordVadGateState;
  inference?: WakeWordInferenceState;
}

export interface WakeWordFrontEndState {
  inputLevel: number;
  noiseFloor: number;
  nextNoiseFloor: number;
  signalThreshold: number;
  signalDelta: number;
  signalPresent: boolean;
  gateOpen: boolean;
}

export interface WakeWordVadGateState {
  threshold: number;
  gateOpen: boolean;
}

export interface WakeWordInferenceState {
  classifierRan: boolean;
}

export interface WakeWordDetector {
  start(): Promise<void>;
  stop(): void;
  predict(pcm: Int16Array): Promise<WakeWordResult>;
  calibrate(scores: number[]): void;
  setThreshold(t: number): void;
  getThreshold(): number;
  isListening(): boolean;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Constants (matching Python openwakeword where applicable)
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1280; // 80ms
const MEL_BINS = 32;
const EMBEDDING_DIM = 96;
const EMBEDDING_WINDOW = 76; // mel frames per embedding
const MEL_CONTEXT_SAMPLES = 160 * 3; // 480 extra samples for mel overlap
const MEL_BUFFER_MAX = 970; // ~10 seconds
const FEATURE_BUFFER_MAX = 120;
const MODEL_INPUT_FRAMES = 16;
const RAW_BUFFER_MAX = SAMPLE_RATE * 10; // 10 seconds

const COOLDOWN_MS = 1000;
const WARMUP_FRAMES = 0;

const DEFAULT_THRESHOLD = 0.8;
const MIN_THRESHOLD = 0.6;

const PCM_NORMALIZATION_FACTOR = 32768;

const WAKE_WORD_BOOTSTRAP_FLOOR_RATIO = 0.8;
const WAKE_WORD_FLOOR_FAST_FALL_RATE = 0.2;
const WAKE_WORD_FLOOR_SLOW_RISE_RATE = 0.02;
const WAKE_WORD_SIGNAL_FLOOR_RATIO = 1.8;
const WAKE_WORD_SIGNAL_FLOOR_MARGIN = 0.004;
const WAKE_WORD_MINIMUM_SIGNAL_LEVEL = 0.0025;
const WAKE_WORD_SIGNAL_HOLD_FRAMES = 3;

const IDLE_PREROLL_CHUNKS = 3;
const IDLE_PREROLL_SAMPLES = IDLE_PREROLL_CHUNKS * CHUNK_SAMPLES;

const VAD_ACTIVITY_LEVEL = 0.015;
const VAD_MIN_RMS_LEVEL = 0.006;
const VAD_MIN_PEAK_LEVEL = 0.03;
const VAD_ZCR_MIN = 0.01;
const VAD_ZCR_MAX = 0.22;
const VAD_ZCR_MAX_FALLOFF = 0.45;

export const WAKE_WORD_VAD_GATE_THRESHOLD = 0.5;

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function createIdleFrontEndState(): WakeWordFrontEndState {
  return {
    inputLevel: 0,
    noiseFloor: 0,
    nextNoiseFloor: 0,
    signalThreshold: WAKE_WORD_MINIMUM_SIGNAL_LEVEL,
    signalDelta: 0,
    signalPresent: false,
    gateOpen: false,
  };
}

export function calculateWakeWordInputLevel(pcm: Int16Array): number {
  if (pcm.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] / PCM_NORMALIZATION_FACTOR;
    sum += sample * sample;
  }

  return Math.sqrt(sum / pcm.length);
}

export function estimateWakeWordVadScore(pcm: Int16Array): number {
  if (pcm.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let activeSamples = 0;
  let previousSign = 0;

  for (let i = 0; i < pcm.length; i += 1) {
    const normalized = pcm[i] / PCM_NORMALIZATION_FACTOR;
    const absValue = Math.abs(normalized);
    const sign = normalized > 0 ? 1 : normalized < 0 ? -1 : 0;

    sumSquares += normalized * normalized;
    if (absValue > peak) {
      peak = absValue;
    }
    if (absValue >= VAD_ACTIVITY_LEVEL) {
      activeSamples += 1;
    }
    if (sign !== 0) {
      if (previousSign !== 0 && sign !== previousSign) {
        zeroCrossings += 1;
      }
      previousSign = sign;
    }
  }

  const rms = Math.sqrt(sumSquares / pcm.length);
  if (
    rms < WAKE_WORD_MINIMUM_SIGNAL_LEVEL * 0.75 &&
    peak < VAD_ACTIVITY_LEVEL
  ) {
    return 0;
  }

  const activityRatio = activeSamples / pcm.length;
  const zeroCrossingRate = zeroCrossings / Math.max(1, pcm.length - 1);

  const rmsScore = clamp01((rms - VAD_MIN_RMS_LEVEL) / 0.03);
  const peakScore = clamp01((peak - VAD_MIN_PEAK_LEVEL) / 0.12);
  const activityScore = clamp01((activityRatio - 0.08) / 0.45);

  let zcrScore = 0;
  if (zeroCrossingRate > 0) {
    if (zeroCrossingRate < VAD_ZCR_MIN) {
      zcrScore = clamp01(zeroCrossingRate / VAD_ZCR_MIN);
    } else if (zeroCrossingRate <= VAD_ZCR_MAX) {
      zcrScore = 1;
    } else {
      zcrScore = clamp01(
        1 -
          (zeroCrossingRate - VAD_ZCR_MAX) /
            (VAD_ZCR_MAX_FALLOFF - VAD_ZCR_MAX),
      );
    }
  }

  return clamp01(
    rmsScore * 0.45 +
      peakScore * 0.2 +
      activityScore * 0.2 +
      zcrScore * 0.15,
  );
}

export function createWakeWordVadGateState(
  vadScore: number,
  threshold = WAKE_WORD_VAD_GATE_THRESHOLD,
): WakeWordVadGateState {
  return {
    threshold,
    gateOpen: vadScore >= threshold,
  };
}

export function float16BitsToNumber(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;

  if (exponent === 0) {
    if (fraction === 0) {
      return sign === -1 ? -0 : 0;
    }
    return sign * Math.pow(2, -14) * (fraction / 1024);
  }

  if (exponent === 0x1f) {
    if (fraction === 0) {
      return sign * Number.POSITIVE_INFINITY;
    }
    return Number.NaN;
  }

  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

export function readScalarTensorValue(
  tensor: Pick<OrtTensor, "data"> & { type?: string },
  tensorType = tensor.type,
): number {
  const value = tensor.data[0];

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (value == null) {
    return 0;
  }

  if (tensorType === "float16") {
    return float16BitsToNumber(Number(value));
  }

  return Number(value);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function createWakeWordDetector(
  modelDir: string,
): Promise<WakeWordDetector> {
  const ort = await loadOrtModule();

  const defaultProviders =
    process.platform === "win32"
      ? ["dml", "cpu"]
      : process.platform === "darwin"
        ? ["coreml", "cpu"]
        : ["cpu"];

  const makeOpts = (executionProviders: string[]): OrtSessionOptions => ({
    executionProviders,
    logSeverityLevel: 3,
  });

  const modelPaths = {
    melspec: path.join(modelDir, "melspectrogram.onnx"),
    embedding: path.join(modelDir, "embedding_model.onnx"),
    wakeword: path.join(modelDir, "stella_wakeword.onnx"),
  };

  let melspecSession: OrtSession;
  let embeddingSession: OrtSession;
  let wakewordSession: OrtSession;
  let wakewordInputName = "x";
  let wakewordOutputName = "";
  let activeProviders = [...defaultProviders];

  async function createAllSessions() {
    const createWithProviders = async (executionProviders: string[]) => {
      activeProviders = [...executionProviders];
      const opts = makeOpts(executionProviders);
      [melspecSession, embeddingSession, wakewordSession] =
        await Promise.all([
          ort.InferenceSession.create(modelPaths.melspec, opts),
          ort.InferenceSession.create(modelPaths.embedding, opts),
          ort.InferenceSession.create(modelPaths.wakeword, opts),
        ]);
    };

    try {
      await createWithProviders(defaultProviders);
    } catch (error) {
      if (process.platform !== "win32" || !defaultProviders.includes("dml")) {
        throw error;
      }
      console.warn("[WakeWord] DirectML init failed, falling back to CPU:", error);
      releaseAllSessions();
      await createWithProviders(["cpu"]);
    }

    wakewordInputName = wakewordSession.inputNames[0] ?? "x";
    wakewordOutputName = wakewordSession.outputNames[0] ?? "";
  }

  function releaseAllSessions() {
    try {
      melspecSession?.release();
    } catch {
      /* ignore */
    }
    try {
      embeddingSession?.release();
    } catch {
      /* ignore */
    }
    try {
      wakewordSession?.release();
    } catch {
      /* ignore */
    }
  }

  await createAllSessions();

  let listening = false;
  let threshold = DEFAULT_THRESHOLD;
  let lastActivationTime = 0;
  let warmupFrames = WARMUP_FRAMES;

  let trackedNoiseFloor = 0;
  let signalHoldFramesRemaining = 0;

  const rawBuffer = new Int16Array(RAW_BUFFER_MAX);
  let rawBufferLen = 0;
  let accumulatedSamples = 0;

  const melBuffer = new Float32Array(MEL_BUFFER_MAX * MEL_BINS).fill(1.0);
  let melRows = EMBEDDING_WINDOW;

  const featureBuffer = new Float32Array(FEATURE_BUFFER_MAX * EMBEDDING_DIM);
  let featureRows = 0;

  async function computeMelspec(
    audioFloat: Float32Array,
  ): Promise<{ data: Float32Array; rows: number }> {
    const results = await melspecSession.run({
      input: new ort.Tensor("float32", audioFloat, [1, audioFloat.length]),
    });
    const output = results[Object.keys(results)[0]] as OrtTensor;
    const rawData = new Float32Array(output.data as Float32Array);
    for (let i = 0; i < rawData.length; i += 1) {
      rawData[i] = rawData[i] / 10.0 + 2.0;
    }

    return { data: rawData, rows: rawData.length / MEL_BINS };
  }

  async function streamingMelspec(nSamples: number): Promise<void> {
    const contextSamples = nSamples + MEL_CONTEXT_SAMPLES;
    const audioFloat = new Float32Array(contextSamples);
    const available = Math.min(rawBufferLen, contextSamples);
    const startIdx = rawBufferLen - available;

    for (let i = 0; i < available; i += 1) {
      audioFloat[contextSamples - available + i] = rawBuffer[startIdx + i];
    }

    const mel = await computeMelspec(audioFloat);

    if (melRows + mel.rows > MEL_BUFFER_MAX) {
      const keep = MEL_BUFFER_MAX - mel.rows;
      if (keep > 0) {
        melBuffer.copyWithin(0, (melRows - keep) * MEL_BINS, melRows * MEL_BINS);
        melRows = keep;
      } else {
        melRows = 0;
      }
    }
    melBuffer.set(mel.data, melRows * MEL_BINS);
    melRows += mel.rows;
  }

  async function computeEmbedding(melWindow: Float32Array): Promise<Float32Array> {
    const results = await embeddingSession.run({
      input_1: new ort.Tensor("float32", melWindow, [
        1,
        EMBEDDING_WINDOW,
        MEL_BINS,
        1,
      ]),
    });
    const output = results[Object.keys(results)[0]] as OrtTensor;
    return new Float32Array(output.data as Float32Array);
  }

  async function runClassifier(features: Float32Array): Promise<number> {
    const results = await wakewordSession.run({
      [wakewordInputName]: new ort.Tensor("float32", features, [
        1,
        MODEL_INPUT_FRAMES,
        EMBEDDING_DIM,
      ]),
    });
    const output = results[wakewordOutputName || Object.keys(results)[0]] as OrtTensor;
    return readScalarTensorValue(output, output.type);
  }

  function bufferRawData(data: Int16Array) {
    if (data.length === 0) {
      return;
    }

    if (data.length >= RAW_BUFFER_MAX) {
      rawBuffer.set(data.subarray(data.length - RAW_BUFFER_MAX));
      rawBufferLen = RAW_BUFFER_MAX;
      return;
    }

    if (rawBufferLen + data.length > RAW_BUFFER_MAX) {
      const keep = RAW_BUFFER_MAX - data.length;
      rawBuffer.copyWithin(0, rawBufferLen - keep, rawBufferLen);
      rawBufferLen = keep;
    }

    rawBuffer.set(data, rawBufferLen);
    rawBufferLen += data.length;
  }

  function trimRawBuffer(keepSamples: number) {
    const clampedKeep = Math.max(0, Math.min(keepSamples, rawBufferLen));
    if (clampedKeep >= rawBufferLen) {
      return;
    }

    rawBuffer.copyWithin(0, rawBufferLen - clampedKeep, rawBufferLen);
    rawBuffer.fill(0, clampedKeep, rawBufferLen);
    rawBufferLen = clampedKeep;
  }

  function trimStreamingBacklog(maxPendingSamples: number) {
    accumulatedSamples = Math.min(accumulatedSamples, maxPendingSamples);
    trimRawBuffer(accumulatedSamples + MEL_CONTEXT_SAMPLES);
  }

  function queueStreamingAudio(pcm: Int16Array): boolean {
    bufferRawData(pcm);
    accumulatedSamples = Math.min(rawBufferLen, accumulatedSamples + pcm.length);
    return accumulatedSamples >= CHUNK_SAMPLES;
  }

  function appendFeatureFrame(embedding: Float32Array) {
    if (featureRows >= FEATURE_BUFFER_MAX) {
      featureBuffer.copyWithin(0, EMBEDDING_DIM, featureRows * EMBEDDING_DIM);
      featureRows = FEATURE_BUFFER_MAX - 1;
    }

    featureBuffer.set(
      embedding.subarray(0, EMBEDDING_DIM),
      featureRows * EMBEDDING_DIM,
    );
    featureRows += 1;
  }

  async function advanceFeatureBuffer(): Promise<void> {
    if (accumulatedSamples < CHUNK_SAMPLES) {
      return;
    }

    const nChunks = Math.floor(accumulatedSamples / CHUNK_SAMPLES);
    const samplesToProcess = nChunks * CHUNK_SAMPLES;

    await streamingMelspec(samplesToProcess);

    for (let i = nChunks - 1; i >= 0; i -= 1) {
      const offset = 8 * i;
      const endMel = melRows - offset;
      const startMel = endMel - EMBEDDING_WINDOW;

      if (startMel < 0 || endMel > melRows) {
        continue;
      }

      const melWindow = melBuffer.slice(startMel * MEL_BINS, endMel * MEL_BINS);
      const embedding = await computeEmbedding(melWindow);
      appendFeatureFrame(embedding);
    }

    accumulatedSamples -= samplesToProcess;
  }

  function detectFromScore(score: number): boolean {
    const now = Date.now();
    const detected = score >= threshold && now - lastActivationTime > COOLDOWN_MS;
    if (detected) {
      lastActivationTime = now;
    }
    return detected;
  }

  function analyzeFrontEnd(pcm: Int16Array): WakeWordFrontEndState {
    const inputLevel = calculateWakeWordInputLevel(pcm);
    const noiseFloor =
      trackedNoiseFloor > 0
        ? trackedNoiseFloor
        : inputLevel * WAKE_WORD_BOOTSTRAP_FLOOR_RATIO;
    const signalThreshold = Math.max(
      noiseFloor * WAKE_WORD_SIGNAL_FLOOR_RATIO,
      noiseFloor + WAKE_WORD_SIGNAL_FLOOR_MARGIN,
      WAKE_WORD_MINIMUM_SIGNAL_LEVEL,
    );
    const signalDelta = Math.max(0, inputLevel - noiseFloor);
    const signalPresent =
      inputLevel >= WAKE_WORD_MINIMUM_SIGNAL_LEVEL &&
      (inputLevel >= signalThreshold ||
        signalDelta > WAKE_WORD_SIGNAL_FLOOR_MARGIN);

    let gateOpen = signalPresent;
    if (signalPresent) {
      signalHoldFramesRemaining = WAKE_WORD_SIGNAL_HOLD_FRAMES;
    } else if (signalHoldFramesRemaining > 0) {
      signalHoldFramesRemaining -= 1;
      gateOpen = true;
    }

    let nextNoiseFloor = noiseFloor;
    if (noiseFloor <= 0) {
      nextNoiseFloor = 0;
    } else if (!gateOpen) {
      const rate =
        inputLevel <= noiseFloor
          ? WAKE_WORD_FLOOR_FAST_FALL_RATE
          : WAKE_WORD_FLOOR_SLOW_RISE_RATE;
      nextNoiseFloor = noiseFloor + (inputLevel - noiseFloor) * rate;
    }

    trackedNoiseFloor = nextNoiseFloor;

    return {
      inputLevel,
      noiseFloor,
      nextNoiseFloor,
      signalThreshold,
      signalDelta,
      signalPresent,
      gateOpen,
    };
  }

  function createResult(
    frontEnd: WakeWordFrontEndState,
    vadScore: number,
    classifierRan: boolean,
    score = 0,
  ): WakeWordResult {
    return {
      detected: false,
      score,
      vadScore,
      frontEnd,
      vadGate: createWakeWordVadGateState(vadScore),
      inference: { classifierRan },
    };
  }

  function resetFeaturePipeline() {
    melBuffer.fill(1.0);
    melRows = EMBEDDING_WINDOW;
    featureBuffer.fill(0);
    featureRows = 0;
  }

  function enterLowComputeIdle() {
    resetFeaturePipeline();
    trimStreamingBacklog(IDLE_PREROLL_SAMPLES);
  }

  async function predict(pcm: Int16Array): Promise<WakeWordResult> {
    if (!listening) {
      return createResult(createIdleFrontEndState(), 0, false);
    }

    const hasChunkReady = queueStreamingAudio(pcm);
    const frontEnd = analyzeFrontEnd(pcm);

    if (!frontEnd.gateOpen) {
      enterLowComputeIdle();
      return createResult(frontEnd, 0, false);
    }

    const vadScore = estimateWakeWordVadScore(pcm);
    const vadGate = createWakeWordVadGateState(vadScore);
    if (!vadGate.gateOpen) {
      enterLowComputeIdle();
      return {
        ...createResult(frontEnd, vadScore, false),
        vadGate,
      };
    }

    if (!hasChunkReady) {
      return {
        ...createResult(frontEnd, vadScore, false),
        vadGate,
      };
    }

    await advanceFeatureBuffer();

    if (warmupFrames > 0) {
      warmupFrames -= 1;
      return {
        ...createResult(frontEnd, vadScore, false),
        vadGate,
      };
    }

    const features = new Float32Array(MODEL_INPUT_FRAMES * EMBEDDING_DIM);
    const available = Math.min(featureRows, MODEL_INPUT_FRAMES);
    if (available > 0) {
      const srcStart = (featureRows - available) * EMBEDDING_DIM;
      const dstStart = (MODEL_INPUT_FRAMES - available) * EMBEDDING_DIM;
      features.set(
        featureBuffer.subarray(srcStart, srcStart + available * EMBEDDING_DIM),
        dstStart,
      );
    }

    const score = await runClassifier(features);
    const finalScore = featureRows < 5 ? 0 : score;
    const detected = detectFromScore(finalScore);

    return {
      detected,
      score: finalScore,
      vadScore,
      frontEnd,
      vadGate,
      inference: { classifierRan: true },
    };
  }

  function resetState() {
    rawBufferLen = 0;
    rawBuffer.fill(0);
    accumulatedSamples = 0;

    trackedNoiseFloor = 0;
    signalHoldFramesRemaining = 0;

    resetFeaturePipeline();

    warmupFrames = WARMUP_FRAMES;
  }

  return {
    async start() {
      listening = true;
      lastActivationTime = 0;
      resetState();
    },
    stop() {
      listening = false;
      lastActivationTime = 0;
    },
    predict,
    calibrate(scores: number[]) {
      if (scores.length === 0) {
        return;
      }
      const minScore = Math.min(...scores);
      threshold = Math.max(MIN_THRESHOLD, minScore - 0.1);
    },
    setThreshold(t: number) {
      threshold = Math.max(MIN_THRESHOLD, t);
    },
    getThreshold() {
      return threshold;
    },
    isListening() {
      return listening;
    },
    dispose() {
      listening = false;
      releaseAllSessions();
    },
  };
}

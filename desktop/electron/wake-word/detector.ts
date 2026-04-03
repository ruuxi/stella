/**
 * Wake word detector using onnxruntime-node.
 *
 * Ports the openWakeWord streaming inference pipeline from Python:
 *   raw audio buffer -> melspectrogram (with context overlap) -> embeddings -> classifier
 *
 * The adaptive front-end and heuristic VAD are retained for telemetry and
 * future tuning, but classifier inference is no longer hard-gated by them.
 */

import path from "path";
import {
  createWakeWordAdaptiveNoiseFloor,
  DEFAULT_ADAPTIVE_NOISE_FLOOR_OPTIONS,
} from "./audio-feed.js";

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

const DEFAULT_THRESHOLD = 0.5;
const MIN_THRESHOLD = 0.5;

// Patience: how many consecutive frames above threshold before triggering.
// Matches openWakeWord's `patience` parameter. 1 = single-frame (default).
const PATIENCE = 2;
const PREDICTION_BUFFER_SIZE = 30;

const PCM_NORMALIZATION_FACTOR = 32768;

// Pre-computed silence embedding: what the embedding model produces for OWW's
// mel buffer init value (np.ones((76,32))). Used to fill the feature buffer on
// reset so the classifier sees the same init state as during training.
const SILENCE_EMBEDDING = new Float32Array([-4.755897, 10.217751, 6.476529, -7.208631, 11.049788, 21.693903, 6.165884, -7.555169, -22.239805, 18.664951, -28.690880, -5.235091, 3.448771, -1.256141, -6.172506, 1.713133, 4.007433, 1.377841, 0.682513, -15.507675, 7.456418, 11.739340, -9.198153, 5.514894, -7.166018, 21.986485, -11.036475, -3.709522, -1.131758, 3.983402, -17.353207, 18.860729, -26.676649, 0.423715, -15.282963, 10.026252, 33.970539, 4.638136, 2.524881, 31.031916, -7.890914, -1.656436, 44.422108, -12.642136, -10.518739, -2.995603, -28.361031, 4.431192, 5.629670, 10.762959, -12.570971, 9.658624, 18.040138, 4.556471, -15.214990, -12.235893, -8.756379, 21.115995, -16.351271, -1.809605, 16.763939, 3.990170, 0.241681, -10.528498, 18.273050, 10.224820, -6.224506, -16.567907, 4.454556, -4.319606, 2.409543, 12.886330, 12.187380, -10.698653, 15.021326, 8.296947, 10.447081, 13.471108, -22.092772, -29.423527, 8.443830, 9.804674, 18.459141, -17.636814, 11.475958, 1.112316, 1.198302, -8.033747, 11.686281, 41.159683, 12.185358, 29.592108, 21.689718, -28.973186, -16.608280, 21.988586]);

// Mel buffer fill value for silence. The melspec model outputs raw log-mel values
// (silence ≈ -74), then the detector applies OWW's transform: x/10 + 2.
// In transformed space, silence = (-74.23)/10 + 2 = -5.42.
// OWW uses np.ones((76,32)) = 1.0 as its init value, which is in transformed space.
// We use 1.0 to match OWW's behavior (the embedding model was trained with this init).
const SILENCE_MEL_VALUE = 1.0;

const WAKE_WORD_BOOTSTRAP_FLOOR_RATIO = 0.8;
const WAKE_WORD_FLOOR_FAST_FALL_RATE = 0.2;
const WAKE_WORD_FLOOR_SLOW_RISE_RATE = 0.02;
const WAKE_WORD_SIGNAL_FLOOR_RATIO = 1.8;
const WAKE_WORD_SIGNAL_FLOOR_MARGIN = 0.004;
const WAKE_WORD_MINIMUM_SIGNAL_LEVEL = 0.0025;
const WAKE_WORD_SIGNAL_HOLD_FRAMES = 3;

const VAD_ACTIVITY_LEVEL = 0.015;
const VAD_MIN_RMS_LEVEL = 0.006;
const VAD_MIN_PEAK_LEVEL = 0.03;
const VAD_ZCR_MIN = 0.01;
const VAD_ZCR_MAX = 0.22;
const VAD_ZCR_MAX_FALLOFF = 0.45;

export const WAKE_WORD_VAD_GATE_THRESHOLD = 0.65;

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
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

  async function createAllSessions() {
    const createWithProviders = async (executionProviders: string[]) => {
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
  let lastOutputScore = 0;

  // Prediction buffer — mirrors openWakeWord's prediction_buffer (deque of 30)
  const predictionBuffer: number[] = [];
  const frontEndStage = createWakeWordAdaptiveNoiseFloor({
    ...DEFAULT_ADAPTIVE_NOISE_FLOOR_OPTIONS,
    bootstrapFloorRatio: WAKE_WORD_BOOTSTRAP_FLOOR_RATIO,
    floorFastFallRate: WAKE_WORD_FLOOR_FAST_FALL_RATE,
    floorSlowRiseRate: WAKE_WORD_FLOOR_SLOW_RISE_RATE,
    signalFloorRatio: WAKE_WORD_SIGNAL_FLOOR_RATIO,
    signalFloorMargin: WAKE_WORD_SIGNAL_FLOOR_MARGIN,
    minimumSignalLevel: WAKE_WORD_MINIMUM_SIGNAL_LEVEL,
    signalHoldFrames: WAKE_WORD_SIGNAL_HOLD_FRAMES,
  });

  const rawBuffer = new Int16Array(RAW_BUFFER_MAX);
  let rawBufferLen = 0;
  let accumulatedSamples = 0;

  const melBuffer = new Float32Array(MEL_BUFFER_MAX * MEL_BINS).fill(SILENCE_MEL_VALUE);
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
      audioFloat[contextSamples - available + i] =
        rawBuffer[startIdx + i] / PCM_NORMALIZATION_FACTOR;
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

  function queueStreamingAudio(pcm: Int16Array): number {
    bufferRawData(pcm);
    accumulatedSamples = Math.min(rawBufferLen, accumulatedSamples + pcm.length);
    return accumulatedSamples;
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

  async function advanceFeatureBuffer(): Promise<number> {
    if (accumulatedSamples < CHUNK_SAMPLES) {
      return 0;
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
    return nChunks;
  }

  function buildClassifierInput(offsetFromLatest = 0): Float32Array {
    const features = new Float32Array(MODEL_INPUT_FRAMES * EMBEDDING_DIM);
    for (let i = 0; i < MODEL_INPUT_FRAMES; i += 1) {
      features.set(SILENCE_EMBEDDING, i * EMBEDDING_DIM);
    }

    const end = Math.max(0, featureRows - offsetFromLatest);
    const start = Math.max(0, end - MODEL_INPUT_FRAMES);
    const available = Math.max(0, end - start);
    if (available > 0) {
      const srcStart = start * EMBEDDING_DIM;
      const dstStart = (MODEL_INPUT_FRAMES - available) * EMBEDDING_DIM;
      features.set(
        featureBuffer.subarray(srcStart, srcStart + available * EMBEDDING_DIM),
        dstStart,
      );
    }

    return features;
  }

  function detectFromScore(score: number): boolean {
    // Append to prediction buffer (mirrors OWW's prediction_buffer deque)
    predictionBuffer.push(score);
    if (predictionBuffer.length > PREDICTION_BUFFER_SIZE) {
      predictionBuffer.shift();
    }

    const now = Date.now();
    if (now - lastActivationTime <= COOLDOWN_MS) {
      return false;
    }

    if (score < threshold) {
      return false;
    }

    // Patience check: last N scores must ALL be >= threshold (OWW semantics)
    if (PATIENCE > 1) {
      const recent = predictionBuffer.slice(-PATIENCE);
      if (recent.length < PATIENCE) {
        return false;
      }
      for (let i = 0; i < recent.length; i += 1) {
        if (recent[i] < threshold) {
          return false;
        }
      }
    }

    lastActivationTime = now;
    return true;
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
    melBuffer.fill(SILENCE_MEL_VALUE);
    melRows = EMBEDDING_WINDOW;
    // Fill feature buffer with silence embeddings instead of zeros so the
    // classifier sees a realistic input even before 16 frames accumulate.
    for (let i = 0; i < FEATURE_BUFFER_MAX; i += 1) {
      featureBuffer.set(SILENCE_EMBEDDING, i * EMBEDDING_DIM);
    }
    featureRows = 0;
  }

  async function predict(pcm: Int16Array): Promise<WakeWordResult> {
    if (!listening) {
      return createResult(frontEndStage.getState(), 0, false);
    }

    const nPreparedSamples = queueStreamingAudio(pcm);

    // Keep front-end state updated for telemetry/debugging, but do not gate
    // classifier inference on it. Over-gating was preventing real detections.
    const frontEnd = frontEndStage.process(pcm).frontEnd;

    const vadScore = estimateWakeWordVadScore(pcm);
    const vadGate = createWakeWordVadGateState(vadScore);

    if (nPreparedSamples < CHUNK_SAMPLES) {
      return {
        detected: detectFromScore(lastOutputScore),
        score: lastOutputScore,
        vadScore,
        frontEnd,
        vadGate,
        inference: { classifierRan: false },
      };
    }

    const nChunks = await advanceFeatureBuffer();

    if (warmupFrames > 0) {
      warmupFrames -= 1;
      return {
        ...createResult(frontEnd, vadScore, false),
        vadGate,
      };
    }

    let score = 0;
    if (nChunks > 1) {
      const scores: number[] = [];
      for (let i = nChunks - 1; i >= 0; i -= 1) {
        scores.push(await runClassifier(buildClassifierInput(i)));
      }
      score = scores.length > 0 ? Math.max(...scores) : 0;
    } else {
      score = await runClassifier(buildClassifierInput(0));
    }

    // Match OWW startup behavior: zero the first few predictions while the
    // streaming buffers stabilize.
    const finalScore = predictionBuffer.length < 5 ? 0 : score;
    lastOutputScore = finalScore;
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

    frontEndStage.reset();
    resetFeaturePipeline();

    warmupFrames = WARMUP_FRAMES;
    lastOutputScore = 0;
    predictionBuffer.length = 0;
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
      lastOutputScore = 0;
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

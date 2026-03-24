/**
 * Wake word detector using onnxruntime-node.
 *
 * Ports the openWakeWord streaming inference pipeline faithfully from Python:
 *   raw audio buffer -> melspectrogram (with context overlap) -> embeddings -> classifier
 *
 * Minimal detector wrapper around the openWakeWord-style streaming frontend.
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
// Constants (matching Python openwakeword)
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

const DEFAULT_THRESHOLD = 0.6;
const MIN_THRESHOLD = 0.6;

export function createWakeWordVadGateState(
  vadScore: number,
  threshold = 0,
): WakeWordVadGateState {
  return {
    threshold,
    gateOpen: vadScore >= threshold || threshold === 0,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function createWakeWordDetector(
  modelDir: string
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
    try { melspecSession?.release(); } catch { /* ignore */ }
    try { embeddingSession?.release(); } catch { /* ignore */ }
    try { wakewordSession?.release(); } catch { /* ignore */ }
  }

  // Initial creation
  await createAllSessions();

  let listening = false;
  let threshold = DEFAULT_THRESHOLD;
  let lastActivationTime = 0;
  let warmupFrames = WARMUP_FRAMES;

  const rawBuffer = new Int16Array(RAW_BUFFER_MAX);
  let rawBufferLen = 0;

  let rawRemainder = new Int16Array(0);
  let accumulatedSamples = 0;

  const melBuffer = new Float32Array(MEL_BUFFER_MAX * MEL_BINS).fill(1.0);
  let melRows = EMBEDDING_WINDOW;

  const featureBuffer = new Float32Array(FEATURE_BUFFER_MAX * EMBEDDING_DIM);
  let featureRows = 0;



  async function computeMelspec(audioFloat: Float32Array): Promise<{ data: Float32Array; rows: number }> {
    const results = await melspecSession.run({
      input: new ort.Tensor("float32", audioFloat, [1, audioFloat.length]),
    });
    const output = results[Object.keys(results)[0]] as OrtTensor;
    const rawData = new Float32Array(output.data as Float32Array);
    for (let i = 0; i < rawData.length; i++) {
      rawData[i] = rawData[i] / 10.0 + 2.0;
    }

    return { data: rawData, rows: rawData.length / MEL_BINS };
  }

  async function streamingMelspec(nSamples: number): Promise<void> {
    const contextSamples = nSamples + MEL_CONTEXT_SAMPLES;
    const audioFloat = new Float32Array(contextSamples);
    const available = Math.min(rawBufferLen, contextSamples);
    const startIdx = rawBufferLen - available;
    
    for (let i = 0; i < available; i++) {
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
      input_1: new ort.Tensor("float32", melWindow, [1, EMBEDDING_WINDOW, MEL_BINS, 1]),
    });
    const output = results[Object.keys(results)[0]] as OrtTensor;
    return new Float32Array(output.data as Float32Array);
  }

  async function runClassifier(features: Float32Array): Promise<number> {
    const results = await wakewordSession.run({
      [wakewordInputName]: new ort.Tensor("float32", features, [1, MODEL_INPUT_FRAMES, EMBEDDING_DIM]),
    });
    const output = results[wakewordOutputName || Object.keys(results)[0]] as OrtTensor;
    return Number((output.data as Float32Array | Float64Array | number[])[0] ?? 0);
  }

  function bufferRawData(data: Int16Array) {
    if (rawBufferLen + data.length > RAW_BUFFER_MAX) {
      const keep = RAW_BUFFER_MAX - data.length;
      rawBuffer.copyWithin(0, rawBufferLen - keep, rawBufferLen);
      rawBufferLen = keep;
    }
    rawBuffer.set(data, rawBufferLen);
    rawBufferLen += data.length;
  }

  function queueStreamingAudio(pcm: Int16Array): boolean {
    if (rawRemainder.length > 0) {
      const combined = new Int16Array(rawRemainder.length + pcm.length);
      combined.set(rawRemainder);
      combined.set(pcm, rawRemainder.length);

      if (accumulatedSamples + combined.length >= CHUNK_SAMPLES) {
        const totalSamples = accumulatedSamples + combined.length;
        const remainder = totalSamples % CHUNK_SAMPLES;
        if (remainder !== 0) {
          bufferRawData(combined.slice(0, combined.length - remainder));
          accumulatedSamples += combined.length - remainder;
          rawRemainder = combined.slice(combined.length - remainder);
        } else {
          bufferRawData(combined);
          accumulatedSamples += combined.length;
          rawRemainder = new Int16Array(0);
        }
        return true;
      }

      accumulatedSamples += combined.length;
      bufferRawData(combined);
      rawRemainder = new Int16Array(0);
      return false;
    }

    if (accumulatedSamples + pcm.length >= CHUNK_SAMPLES) {
      const totalSamples = accumulatedSamples + pcm.length;
      const remainder = totalSamples % CHUNK_SAMPLES;
      if (remainder !== 0) {
        bufferRawData(pcm.slice(0, pcm.length - remainder));
        accumulatedSamples += pcm.length - remainder;
        rawRemainder = pcm.slice(pcm.length - remainder);
      } else {
        bufferRawData(pcm);
        accumulatedSamples += pcm.length;
      }
      return true;
    }

    accumulatedSamples += pcm.length;
    bufferRawData(pcm);
    return false;
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
    featureRows++;
  }

  async function advanceFeatureBuffer(): Promise<void> {
    if (accumulatedSamples < CHUNK_SAMPLES) {
      return;
    }

    const nChunks = Math.floor(accumulatedSamples / CHUNK_SAMPLES);
    const samplesToProcess = nChunks * CHUNK_SAMPLES;

    await streamingMelspec(samplesToProcess);

    for (let i = nChunks - 1; i >= 0; i--) {
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

  async function predict(pcm: Int16Array): Promise<WakeWordResult> {
    const none: WakeWordResult = {
      detected: false,
      score: 0,
      vadScore: 0,
      vadGate: createWakeWordVadGateState(0),
      inference: { classifierRan: false },
    };
    if (!listening) return none;

    if (!queueStreamingAudio(pcm)) {
      return {
        detected: false,
        score: 0,
        vadScore: 0,
        vadGate: createWakeWordVadGateState(0),
        inference: { classifierRan: false },
      };
    }

    await advanceFeatureBuffer();

    if (warmupFrames > 0) {
      warmupFrames--;
      return {
        detected: false,
        score: 0,
        vadScore: 0,
        vadGate: createWakeWordVadGateState(0),
        inference: { classifierRan: false },
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
    const finalScore = featureRows < 5 ? 0.0 : score;
    const detected = detectFromScore(finalScore);

    return {
      detected,
      score: finalScore,
      vadScore: 0,
      vadGate: createWakeWordVadGateState(0),
      inference: { classifierRan: true },
    };
  }

  function resetToSilence() {
    melBuffer.fill(1.0);
    melRows = EMBEDDING_WINDOW;
    featureBuffer.fill(0);
    featureRows = 0;

    accumulatedSamples = 0;
    rawRemainder = new Int16Array(0);
  }

  function resetState() {
    rawBufferLen = 0;
    rawBuffer.fill(0);

    resetToSilence();

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
      if (scores.length === 0) return;
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

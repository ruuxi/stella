/**
 * Wake word detector using onnxruntime-node.
 *
 * Ports the openWakeWord streaming inference pipeline faithfully from Python:
 *   raw audio buffer -> melspectrogram (with context overlap) -> embeddings -> classifier
 *
 * With Silero VAD pre-filter, confidence stacking, and threshold calibration.
 */

import path from "path";

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;
type OrtSessionOptions = import("onnxruntime-node").InferenceSession.SessionOptions;
type OrtTensor = import("onnxruntime-node").Tensor;
type OrtValueMetadata = import("onnxruntime-node").InferenceSession.ValueMetadata;

const NativeFloat16Array = globalThis.Float16Array;
let ortModulePromise: Promise<OrtModule> | null = null;

async function loadOrtModule(): Promise<OrtModule> {
  if (!ortModulePromise) {
    const originalFloat16Array = globalThis.Float16Array;
    try {
      // onnxruntime-node 1.24.x decides float16 CPU tensor handling on the first
      // Tensor construction, not just at import time. Hide Float16Array so the
      // runtime locks onto Uint16Array-backed float16 tensors.
      Object.defineProperty(globalThis, "Float16Array", {
        configurable: true,
        value: undefined,
        writable: true,
      });
    } catch {
      // ignore; we'll restore whatever state we can after import
    }

    ortModulePromise = import("onnxruntime-node")
      .then((ort) => {
        // Force the one-time typed-array check while Float16Array is hidden.
        new ort.Tensor("float16", new Uint16Array(1), [1]);
        return ort;
      })
      .finally(() => {
        try {
          Object.defineProperty(globalThis, "Float16Array", {
            configurable: true,
            value: originalFloat16Array,
            writable: true,
          });
        } catch {
          globalThis.Float16Array = originalFloat16Array;
        }
      });
  }
  return ortModulePromise;
}

function toFloat16Buffer(values: Float32Array): Uint16Array {
  if (!NativeFloat16Array) {
    throw new Error("Float16Array is not available; cannot prepare fp16 wake-word input");
  }
  const half = new NativeFloat16Array(values);
  return new Uint16Array(half.buffer, half.byteOffset, half.length);
}

export function float16BitsToNumber(bits: number): number {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;

  if (exponent === 0) {
    if (fraction === 0) {
      return sign * 0;
    }
    return sign * 2 ** (-14) * (fraction / 1024);
  }

  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }

  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function readScalarTensorValue(
  tensor: OrtTensor,
  tensorType: "float16" | "float32",
): number {
  if (tensorType === "float16") {
    const data = tensor.data as Uint16Array;
    if (!data || data.length === 0) {
      return 0;
    }
    return float16BitsToNumber(data[0] ?? 0);
  }

  const data = tensor.data as Float32Array | Float64Array | number[];
  if (!data || data.length === 0) {
    return 0;
  }
  return Number(data[0] ?? 0);
}

function isTensorMetadata(
  metadata: OrtValueMetadata | undefined,
): metadata is Extract<OrtValueMetadata, { isTensor: true }> {
  return Boolean(metadata?.isTensor);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WakeWordResult {
  detected: boolean;
  score: number;
  vadScore: number;
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

// VAD (Silero v6: 512-sample frames, combined state [2,1,128], 64-sample context window)
const VAD_FRAME_SIZE = 512; // 32ms
const VAD_CONTEXT_SIZE = 64; // context window prepended to each frame
const VAD_STATE_DIM = 128;
const VAD_THRESHOLD = 0.5;

const STACK_WINDOW = 5;
const STACK_REQUIRED = 3;
const COOLDOWN_MS = 1000;
const WARMUP_FRAMES = 0;

// Calibrated from the current Stella fp16 export benchmark (iter_030).
const DEFAULT_THRESHOLD = 0.70;
const MIN_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function createWakeWordDetector(
  modelDir: string
): Promise<WakeWordDetector> {
  const ort = await loadOrtModule();
  const opts: OrtSessionOptions = {
    executionProviders:
      process.platform === "win32"
        ? ["dml", "cpu"]
        : process.platform === "darwin"
          ? ["coreml", "cpu"]
          : ["cpu"],
    logSeverityLevel: 3,
  };

  const modelPaths = {
    melspec: path.join(modelDir, "melspectrogram.onnx"),
    embedding: path.join(modelDir, "embedding_model.onnx"),
    wakeword: path.join(modelDir, "stella_wakeword_fp16.onnx"),
    vad: path.join(modelDir, "silero_vad.onnx"),
  };

  let melspecSession: OrtSession;
  let embeddingSession: OrtSession;
  let wakewordSession: OrtSession;
  let vadSession: OrtSession;
  let wakewordInputType: "float16" | "float32" = "float32";
  let wakewordOutputType: "float16" | "float32" = "float32";
  let wakewordInputName = "x";
  let wakewordOutputName = "";

  const silenceEmbedding = new Float32Array(EMBEDDING_DIM);

  async function createAllSessions() {
    [melspecSession, embeddingSession, wakewordSession, vadSession] =
      await Promise.all([
        ort.InferenceSession.create(modelPaths.melspec, opts),
        ort.InferenceSession.create(modelPaths.embedding, opts),
        ort.InferenceSession.create(modelPaths.wakeword, opts),
        ort.InferenceSession.create(modelPaths.vad, opts),
      ]);

    const wakewordMetadata = wakewordSession.inputMetadata.find(
      (meta) => meta.name === wakewordSession.inputNames[0],
    );
    const wakewordOutputMetadata = wakewordSession.outputMetadata.find(
      (meta) => meta.name === wakewordSession.outputNames[0],
    );
    wakewordInputName = wakewordSession.inputNames[0] ?? "x";
    wakewordOutputName = wakewordSession.outputNames[0] ?? "";
    wakewordInputType =
      isTensorMetadata(wakewordMetadata) && wakewordMetadata.type === "float16"
        ? "float16"
        : "float32";
    wakewordOutputType =
      isTensorMetadata(wakewordOutputMetadata) &&
      wakewordOutputMetadata.type === "float16"
        ? "float16"
        : "float32";

    const silenceMelWindow = new Float32Array(EMBEDDING_WINDOW * MEL_BINS).fill(1.0);
    const results = await embeddingSession.run({
      input_1: new ort.Tensor("float32", silenceMelWindow, [1, EMBEDDING_WINDOW, MEL_BINS, 1]),
    });
    const output = results[Object.keys(results)[0]] as OrtTensor;
    silenceEmbedding.set(new Float32Array(output.data as Float32Array).subarray(0, EMBEDDING_DIM));
  }

  function releaseAllSessions() {
    try { melspecSession?.release(); } catch { /* ignore */ }
    try { embeddingSession?.release(); } catch { /* ignore */ }
    try { wakewordSession?.release(); } catch { /* ignore */ }
    try { vadSession?.release(); } catch { /* ignore */ }
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

  const recentScores: number[] = [];

  let vadState = new Float32Array(2 * 1 * VAD_STATE_DIM);
  let vadContext = new Float32Array(VAD_CONTEXT_SIZE);

  async function runVad(pcm: Int16Array): Promise<number> {
    const scores: number[] = [];
    for (let i = 0; i <= pcm.length - VAD_FRAME_SIZE; i += VAD_FRAME_SIZE) {
      const frame = new Float32Array(VAD_FRAME_SIZE);
      for (let j = 0; j < VAD_FRAME_SIZE; j++) {
        frame[j] = pcm[i + j] / 32767;
      }

      const input = new Float32Array(VAD_CONTEXT_SIZE + VAD_FRAME_SIZE);
      input.set(vadContext, 0);
      input.set(frame, VAD_CONTEXT_SIZE);

      const results = await vadSession.run({
        input: new ort.Tensor("float32", input, [1, input.length]),
        state: new ort.Tensor("float32", new Float32Array(vadState), [2, 1, VAD_STATE_DIM]),
        sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
      });
      scores.push((results.output as OrtTensor).data[0] as number);
      vadState = new Float32Array((results.stateN as OrtTensor).data as Float32Array);
      vadContext = input.slice(input.length - VAD_CONTEXT_SIZE);
    }
    return scores.length > 0 ? scores.reduce((a, b) => a + b) / scores.length : 0;
  }

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
    const classifierInput =
      wakewordInputType === "float16"
        ? new ort.Tensor("float16", toFloat16Buffer(features), [1, MODEL_INPUT_FRAMES, EMBEDDING_DIM])
        : new ort.Tensor("float32", features, [1, MODEL_INPUT_FRAMES, EMBEDDING_DIM]);
    const results = await wakewordSession.run({
      [wakewordInputName]: classifierInput,
    });
    const output = results[wakewordOutputName || Object.keys(results)[0]] as OrtTensor;
    return readScalarTensorValue(output, wakewordOutputType);
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

  async function predict(pcm: Int16Array): Promise<WakeWordResult> {
    const none: WakeWordResult = { detected: false, score: 0, vadScore: 0 };
    if (!listening) return none;

    const vadScore = await runVad(pcm);

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
      } else {
        accumulatedSamples += combined.length;
        bufferRawData(combined);
        rawRemainder = new Int16Array(0);
        return { detected: false, score: 0, vadScore };
      }
    } else {
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
      } else {
        accumulatedSamples += pcm.length;
        bufferRawData(pcm);
        return { detected: false, score: 0, vadScore };
      }
    }

    if (accumulatedSamples >= CHUNK_SAMPLES) {
      const nChunks = Math.floor(accumulatedSamples / CHUNK_SAMPLES);
      const samplesToProcess = nChunks * CHUNK_SAMPLES;
      await streamingMelspec(samplesToProcess);

      for (let i = nChunks - 1; i >= 0; i--) {
        const offset = 8 * i;
        const endMel = melRows - offset;
        const startMel = endMel - EMBEDDING_WINDOW;

        if (startMel < 0 || endMel > melRows) continue;

        const melWindow = melBuffer.slice(startMel * MEL_BINS, endMel * MEL_BINS);
        const embedding = await computeEmbedding(melWindow);

        if (featureRows >= FEATURE_BUFFER_MAX) {
          featureBuffer.copyWithin(0, EMBEDDING_DIM, featureRows * EMBEDDING_DIM);
          featureRows = FEATURE_BUFFER_MAX - 1;
        }
        
        featureBuffer.set(embedding.subarray(0, EMBEDDING_DIM), featureRows * EMBEDDING_DIM);
        featureRows++;
      }

      accumulatedSamples = accumulatedSamples - samplesToProcess;
    }

    if (warmupFrames > 0) {
      warmupFrames--;
      return { detected: false, score: 0, vadScore };
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

    recentScores.push(finalScore);
    if (recentScores.length > STACK_WINDOW) recentScores.shift();

    let consecutive = 0;
    for (let j = recentScores.length - 1; j >= 0; j--) {
      if (recentScores[j] >= threshold) consecutive++;
      else break;
    }

    const now = Date.now();
    const detected = consecutive >= STACK_REQUIRED && now - lastActivationTime > COOLDOWN_MS;

    if (detected) {
      lastActivationTime = now;
      recentScores.length = 0;
    }

    return { detected, score: finalScore, vadScore };
  }

  function resetToSilence() {
    melBuffer.fill(1.0);
    melRows = EMBEDDING_WINDOW;
    for (let i = 0; i < MODEL_INPUT_FRAMES; i++) {
      featureBuffer.set(silenceEmbedding, i * EMBEDDING_DIM);
    }
    featureRows = MODEL_INPUT_FRAMES;
    
    accumulatedSamples = 0;
    rawRemainder = new Int16Array(0);
    recentScores.length = 0;
    
    vadState.fill(0);
    vadContext.fill(0);
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

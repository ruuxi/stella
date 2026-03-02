/**
 * Wake word detector using onnxruntime-node.
 *
 * Ports the openWakeWord streaming inference pipeline faithfully from Python:
 *   raw audio buffer -> melspectrogram (with context overlap) -> embeddings -> classifier
 *
 * With Silero VAD pre-filter, confidence stacking, and threshold calibration.
 */

import * as ort from "onnxruntime-node";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WakeWordResult {
  detected: boolean;
  score: number;
  vadScore: number;
}

export interface WakeWordDetector {
  start(): void;
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

// Confidence stacking
const STACK_WINDOW = 5;
const STACK_REQUIRED = 3;
const COOLDOWN_MS = 3000;

const DEFAULT_THRESHOLD = 0.5;
const MIN_THRESHOLD = 0.3;

// RMS gate — skip all inference when audio is near-silent
const RMS_THRESHOLD = 200; // int16 scale; ~0.006 normalized

function computeRms(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function createWakeWordDetector(
  modelDir: string
): Promise<WakeWordDetector> {
  const opts: ort.InferenceSession.SessionOptions = {
    executionProviders:
      process.platform === "win32"
        ? ["dml", "cpu"]
        : process.platform === "darwin"
          ? ["coreml", "cpu"]
          : ["cpu"],
    logSeverityLevel: 3,
  };

  const [melspecSession, embeddingSession, wakewordSession, vadSession] =
    await Promise.all([
      ort.InferenceSession.create(path.join(modelDir, "melspectrogram.onnx"), opts),
      ort.InferenceSession.create(path.join(modelDir, "embedding_model.onnx"), opts),
      ort.InferenceSession.create(path.join(modelDir, "stella_wakeword.onnx"), opts),
      ort.InferenceSession.create(path.join(modelDir, "silero_vad.onnx"), opts),
    ]);

  // State
  let listening = false;
  let threshold = DEFAULT_THRESHOLD;
  let lastActivationTime = 0;
  let warmupFrames = 5;

  // Raw audio buffer (circular, matching Python deque(maxlen=sr*10))
  let rawBuffer = new Int16Array(RAW_BUFFER_MAX);
  let rawBufferLen = 0;

  // Remainder from incomplete chunks
  let rawRemainder = new Int16Array(0);
  let accumulatedSamples = 0;

  // Mel buffer: initialized with ONES (matching Python np.ones((76,32)))
  let melBuffer = new Float32Array(MEL_BUFFER_MAX * MEL_BINS).fill(1.0);
  let melRows = EMBEDDING_WINDOW; // start at 76

  // Feature buffer
  let featureBuffer = new Float32Array(FEATURE_BUFFER_MAX * EMBEDDING_DIM);
  let featureRows = 0;

  // Confidence stacking
  const recentScores: number[] = [];

  // VAD state (Silero v6: combined state + context window)
  let vadState = new Float32Array(2 * 1 * VAD_STATE_DIM);
  let vadContext = new Float32Array(VAD_CONTEXT_SIZE);

  // ---- VAD (Silero v6) ----
  async function runVad(pcm: Int16Array): Promise<number> {
    const scores: number[] = [];
    for (let i = 0; i <= pcm.length - VAD_FRAME_SIZE; i += VAD_FRAME_SIZE) {
      const frame = new Float32Array(VAD_FRAME_SIZE);
      for (let j = 0; j < VAD_FRAME_SIZE; j++) {
        frame[j] = pcm[i + j] / 32767;
      }

      // Prepend context window to frame (576 = 64 + 512)
      const input = new Float32Array(VAD_CONTEXT_SIZE + VAD_FRAME_SIZE);
      input.set(vadContext, 0);
      input.set(frame, VAD_CONTEXT_SIZE);

      const results = await vadSession.run({
        input: new ort.Tensor("float32", input, [1, input.length]),
        state: new ort.Tensor("float32", new Float32Array(vadState), [2, 1, VAD_STATE_DIM]),
        sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
      });
      scores.push((results.output as ort.Tensor).data[0] as number);
      vadState = new Float32Array((results.stateN as ort.Tensor).data as Float32Array);

      // Slide context: last 64 samples of combined input
      vadContext = input.slice(input.length - VAD_CONTEXT_SIZE);
    }
    return scores.length > 0 ? scores.reduce((a, b) => a + b) / scores.length : 0;
  }

  // ---- Melspectrogram ----
  async function computeMelspec(audioFloat: Float32Array): Promise<{ data: Float32Array; rows: number }> {
    const results = await melspecSession.run({
      input: new ort.Tensor("float32", audioFloat, [1, audioFloat.length]),
    });
    const output = results[Object.keys(results)[0]] as ort.Tensor;
    const rawData = new Float32Array(output.data as Float32Array);

    // Post-process: output / 10.0 + 2.0 (matching Python default)
    for (let i = 0; i < rawData.length; i++) {
      rawData[i] = rawData[i] / 10.0 + 2.0;
    }

    return { data: rawData, rows: rawData.length / MEL_BINS };
  }

  // ---- Streaming melspectrogram (matching Python _streaming_melspectrogram) ----
  async function streamingMelspec(nSamples: number): Promise<void> {
    // Python: list(self.raw_data_buffer)[-n_samples - 160*3:]
    // Take last (nSamples + 480) samples for context overlap
    const contextSamples = nSamples + MEL_CONTEXT_SAMPLES;
    const startIdx = Math.max(0, rawBufferLen - contextSamples);
    const sliceLen = rawBufferLen - startIdx;

    // Convert int16 to float32 (no normalization — matching Python x.astype(np.float32))
    const audioFloat = new Float32Array(sliceLen);
    for (let i = 0; i < sliceLen; i++) {
      audioFloat[i] = rawBuffer[startIdx + i];
    }

    const mel = await computeMelspec(audioFloat);

    // Append to mel buffer (shift if full)
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

  // ---- Embedding ----
  async function computeEmbedding(melWindow: Float32Array): Promise<Float32Array> {
    const results = await embeddingSession.run({
      input_1: new ort.Tensor("float32", melWindow, [1, EMBEDDING_WINDOW, MEL_BINS, 1]),
    });
    const output = results[Object.keys(results)[0]] as ort.Tensor;
    return new Float32Array(output.data as Float32Array);
  }

  // ---- Classifier ----
  async function runClassifier(features: Float32Array): Promise<number> {
    const results = await wakewordSession.run({
      x: new ort.Tensor("float32", features, [1, MODEL_INPUT_FRAMES, EMBEDDING_DIM]),
    });
    const output = results[Object.keys(results)[0]] as ort.Tensor;
    return output.data[0] as number;
  }

  // ---- Buffer raw audio (matching Python _buffer_raw_data) ----
  function bufferRawData(data: Int16Array) {
    if (rawBufferLen + data.length > RAW_BUFFER_MAX) {
      const keep = RAW_BUFFER_MAX - data.length;
      rawBuffer.copyWithin(0, rawBufferLen - keep, rawBufferLen);
      rawBufferLen = keep;
    }
    rawBuffer.set(data, rawBufferLen);
    rawBufferLen += data.length;
  }

  // ---- Main predict (matching Python _streaming_features + predict) ----
  async function predict(pcm: Int16Array): Promise<WakeWordResult> {
    const none: WakeWordResult = { detected: false, score: 0, vadScore: 0 };
    if (!listening) return none;

    // ── Gate 1: RMS ── Skip all inference when audio is near-silent (~0 CPU)
    const rms = computeRms(pcm);
    if (rms < RMS_THRESHOLD) {
      // Still buffer the audio so context overlap works when speech starts
      bufferRawData(pcm);
      return none;
    }

    // ── Gate 2: VAD ── Only run mel/embedding/classifier on speech
    const vadScore = await runVad(pcm);

    // Prepend remainder from previous call
    let x: Int16Array;
    if (rawRemainder.length > 0) {
      x = new Int16Array(rawRemainder.length + pcm.length);
      x.set(rawRemainder);
      x.set(pcm, rawRemainder.length);
      rawRemainder = new Int16Array(0);
    } else {
      x = pcm;
    }

    // Always buffer raw audio (needed for mel context overlap)
    if (accumulatedSamples + x.length >= CHUNK_SAMPLES) {
      const totalSamples = accumulatedSamples + x.length;
      const remainder = totalSamples % CHUNK_SAMPLES;
      if (remainder !== 0) {
        bufferRawData(x.slice(0, x.length - remainder));
        accumulatedSamples += x.length - remainder;
        rawRemainder = x.slice(x.length - remainder);
      } else {
        bufferRawData(x);
        accumulatedSamples += x.length;
      }
    } else {
      accumulatedSamples += x.length;
      bufferRawData(x);
      return none;
    }

    // VAD gate: buffer audio but skip expensive mel/embedding/classifier
    if (vadScore < VAD_THRESHOLD) {
      // Still consume accumulated samples so we don't re-process stale audio
      accumulatedSamples = 0;
      return { detected: false, score: 0, vadScore };
    }

    // ── Mel + Embedding + Classifier (only runs on speech) ──
    if (accumulatedSamples >= CHUNK_SAMPLES && accumulatedSamples % CHUNK_SAMPLES === 0) {
      // Streaming mel with context overlap
      await streamingMelspec(accumulatedSamples);

      // Compute embeddings (matching Python loop)
      const nChunks = accumulatedSamples / CHUNK_SAMPLES;
      for (let i = nChunks - 1; i >= 0; i--) {
        const offset = 8 * i;
        const endMel = melRows - offset;
        const startMel = endMel - EMBEDDING_WINDOW;

        if (startMel < 0 || endMel > melRows || endMel - startMel !== EMBEDDING_WINDOW) {
          continue;
        }

        const melWindow = new Float32Array(EMBEDDING_WINDOW * MEL_BINS);
        melWindow.set(melBuffer.subarray(startMel * MEL_BINS, endMel * MEL_BINS));
        const embedding = await computeEmbedding(melWindow);

        if (featureRows >= FEATURE_BUFFER_MAX) {
          featureBuffer.copyWithin(0, EMBEDDING_DIM, featureRows * EMBEDDING_DIM);
          featureRows = FEATURE_BUFFER_MAX - 1;
        }
        featureBuffer.set(embedding.subarray(0, EMBEDDING_DIM), featureRows * EMBEDDING_DIM);
        featureRows++;
      }

      accumulatedSamples = 0;
    }

    // Warm-up skip
    if (warmupFrames > 0) {
      warmupFrames--;
      return { detected: false, score: 0, vadScore };
    }

    // Get last MODEL_INPUT_FRAMES embeddings, zero-pad if fewer available
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

    // Confidence stacking
    recentScores.push(score);
    if (recentScores.length > STACK_WINDOW) recentScores.shift();

    let consecutive = 0;
    for (let i = recentScores.length - 1; i >= 0; i--) {
      if (recentScores[i] >= threshold) consecutive++;
      else break;
    }

    const now = Date.now();
    const detected = consecutive >= STACK_REQUIRED && now - lastActivationTime > COOLDOWN_MS;

    if (detected) {
      lastActivationTime = now;
      recentScores.length = 0;
    }

    return { detected, score, vadScore };
  }

  // ---- Reset ----
  function resetState() {
    rawBuffer.fill(0);
    rawBufferLen = 0;
    rawRemainder = new Int16Array(0);
    accumulatedSamples = 0;
    melBuffer.fill(1.0); // Python initializes with ones
    melRows = EMBEDDING_WINDOW; // 76 rows of ones
    featureBuffer.fill(0);
    featureRows = 0;
    recentScores.length = 0;
    vadState.fill(0);
    vadContext.fill(0);
    warmupFrames = 5;
  }

  return {
    start() {
      listening = true;
      resetState();
    },
    stop() {
      listening = false;
    },
    predict,
    calibrate(scores: number[]) {
      if (scores.length === 0) return;
      const minScore = Math.min(...scores);
      threshold = Math.max(MIN_THRESHOLD, minScore - 0.1);
      console.log(`[WakeWord] Calibrated: threshold=${threshold.toFixed(3)} (min=${minScore.toFixed(3)}, n=${scores.length})`);
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
      melspecSession.release();
      embeddingSession.release();
      wakewordSession.release();
      vadSession.release();
    },
  };
}

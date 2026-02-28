/**
 * Wake word detector using onnxruntime-node.
 *
 * Ports the openWakeWord inference pipeline (melspectrogram -> embedding -> classifier)
 * with Silero VAD pre-filter, confidence stacking, and threshold calibration.
 *
 * All inference is async (onnxruntime-node returns Promises).
 * Audio is fed in 1280-sample (80ms) chunks of 16kHz int16 mono PCM.
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
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1280; // 80ms
const MEL_BINS = 32;
const EMBEDDING_DIM = 96;
const EMBEDDING_WINDOW = 76;
const EMBEDDING_STEP = 8;
const MEL_BUFFER_MAX = 970;
const FEATURE_BUFFER_MAX = 120;
const MODEL_INPUT_FRAMES = 16;

const VAD_FRAME_SIZE = 480; // 30ms
const VAD_THRESHOLD = 0.5;

const STACK_WINDOW = 5;
const STACK_REQUIRED = 3;
const COOLDOWN_MS = 3000;

const DEFAULT_THRESHOLD = 0.5;
const MIN_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function createWakeWordDetector(
  modelDir: string
): Promise<WakeWordDetector> {
  const opts: ort.InferenceSession.SessionOptions = {
    executionProviders: ["cpu"],
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
  let rawRemainder = new Int16Array(0);
  let warmupFrames = 5;

  // Mel buffer: flat array, melRows tracks how many rows are filled
  const melBuffer = new Float32Array(MEL_BUFFER_MAX * MEL_BINS);
  let melRows = 0;

  // Feature buffer: flat array
  const featureBuffer = new Float32Array(FEATURE_BUFFER_MAX * EMBEDDING_DIM);
  let featureRows = 0;

  // Confidence stacking
  const recentScores: number[] = [];

  // VAD LSTM state
  let vadH = new Float32Array(2 * 1 * 64);
  let vadC = new Float32Array(2 * 1 * 64);

  // ---- VAD ----
  async function runVad(pcm: Int16Array): Promise<number> {
    const scores: number[] = [];
    for (let i = 0; i <= pcm.length - VAD_FRAME_SIZE; i += VAD_FRAME_SIZE) {
      const chunk = new Float32Array(VAD_FRAME_SIZE);
      for (let j = 0; j < VAD_FRAME_SIZE; j++) {
        chunk[j] = pcm[i + j] / 32767;
      }

      const results = await vadSession.run({
        input: new ort.Tensor("float32", chunk, [1, VAD_FRAME_SIZE]),
        h: new ort.Tensor("float32", new Float32Array(vadH), [2, 1, 64]),
        c: new ort.Tensor("float32", new Float32Array(vadC), [2, 1, 64]),
        sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
      });

      const keys = Object.keys(results);
      scores.push((results[keys[0]] as ort.Tensor).data[0] as number);
      vadH = new Float32Array((results[keys[1]] as ort.Tensor).data as Float32Array);
      vadC = new Float32Array((results[keys[2]] as ort.Tensor).data as Float32Array);
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

    // Post-process to match Python: output / 10.0 + 2.0
    for (let i = 0; i < rawData.length; i++) {
      rawData[i] = rawData[i] / 10.0 + 2.0;
    }

    const rows = rawData.length / MEL_BINS;
    return { data: rawData, rows };
  }

  // ---- Embedding ----
  async function computeEmbedding(melWindow: Float32Array): Promise<Float32Array> {
    const results = await embeddingSession.run({
      input_1: new ort.Tensor("float32", melWindow, [1, EMBEDDING_WINDOW, MEL_BINS, 1]),
    });
    const output = results[Object.keys(results)[0]] as ort.Tensor;
    return new Float32Array(output.data as Float32Array);
  }

  // ---- Wake word classifier ----
  async function runClassifier(features: Float32Array): Promise<number> {
    const results = await wakewordSession.run({
      x: new ort.Tensor("float32", features, [1, MODEL_INPUT_FRAMES, EMBEDDING_DIM]),
    });
    const output = results[Object.keys(results)[0]] as ort.Tensor;
    return output.data[0] as number;
  }

  // ---- Main predict pipeline ----
  async function predict(pcm: Int16Array): Promise<WakeWordResult> {
    const none: WakeWordResult = { detected: false, score: 0, vadScore: 0 };
    if (!listening) return none;

    // Prepend remainder from previous call
    let allSamples: Int16Array;
    if (rawRemainder.length > 0) {
      allSamples = new Int16Array(rawRemainder.length + pcm.length);
      allSamples.set(rawRemainder);
      allSamples.set(pcm, rawRemainder.length);
      rawRemainder = new Int16Array(0);
    } else {
      allSamples = pcm;
    }

    // Align to 1280-sample chunks
    const nChunks = Math.floor(allSamples.length / CHUNK_SAMPLES);
    const usable = nChunks * CHUNK_SAMPLES;
    if (allSamples.length > usable) {
      rawRemainder = allSamples.slice(usable);
    }
    if (nChunks === 0) return none;

    const audio = allSamples.slice(0, usable);

    // 1. VAD pre-filter
    const vadScore = await runVad(audio);
    if (vadScore < VAD_THRESHOLD) {
      return { detected: false, score: 0, vadScore };
    }

    // 2. Melspectrogram
    const audioFloat = new Float32Array(usable);
    for (let i = 0; i < usable; i++) {
      audioFloat[i] = audio[i];
    }
    const mel = await computeMelspec(audioFloat);

    // Append to mel buffer (shift if full)
    if (melRows + mel.rows > MEL_BUFFER_MAX) {
      const keep = MEL_BUFFER_MAX - mel.rows;
      const shift = melRows - keep;
      if (shift > 0 && keep > 0) {
        melBuffer.copyWithin(0, shift * MEL_BINS, melRows * MEL_BINS);
        melRows = keep;
      } else {
        melRows = 0;
      }
    }
    melBuffer.set(mel.data, melRows * MEL_BINS);
    melRows += mel.rows;

    // 3. Compute embeddings for new chunks
    for (let chunk = 0; chunk < nChunks; chunk++) {
      const endIdx = melRows - (nChunks - 1 - chunk) * EMBEDDING_STEP;
      const startIdx = endIdx - EMBEDDING_WINDOW;
      if (startIdx < 0 || endIdx > melRows) continue;

      const melWindow = new Float32Array(EMBEDDING_WINDOW * MEL_BINS);
      melWindow.set(
        melBuffer.subarray(startIdx * MEL_BINS, endIdx * MEL_BINS)
      );

      const embedding = await computeEmbedding(melWindow);

      // Append to feature buffer (shift if full)
      if (featureRows >= FEATURE_BUFFER_MAX) {
        featureBuffer.copyWithin(0, EMBEDDING_DIM, featureRows * EMBEDDING_DIM);
        featureRows = FEATURE_BUFFER_MAX - 1;
      }
      featureBuffer.set(embedding.slice(0, EMBEDDING_DIM), featureRows * EMBEDDING_DIM);
      featureRows++;
    }

    // 4. Need enough features for the model
    if (featureRows < MODEL_INPUT_FRAMES) {
      return { detected: false, score: 0, vadScore };
    }

    // Warm-up skip
    if (warmupFrames > 0) {
      warmupFrames--;
      return { detected: false, score: 0, vadScore };
    }

    // Get last MODEL_INPUT_FRAMES embeddings
    const startF = (featureRows - MODEL_INPUT_FRAMES) * EMBEDDING_DIM;
    const features = featureBuffer.slice(startF, startF + MODEL_INPUT_FRAMES * EMBEDDING_DIM);

    const score = await runClassifier(features);

    // 5. Confidence stacking
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
    rawRemainder = new Int16Array(0);
    melBuffer.fill(0);
    melRows = 0;
    featureBuffer.fill(0);
    featureRows = 0;
    recentScores.length = 0;
    vadH.fill(0);
    vadC.fill(0);
    warmupFrames = 5;
  }

  // ---- Public API ----
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
      console.log(
        `[WakeWord] Calibrated: threshold=${threshold.toFixed(3)} (min=${minScore.toFixed(3)}, n=${scores.length})`
      );
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

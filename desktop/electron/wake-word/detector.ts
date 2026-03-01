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
// Constants (matching Python openwakeword/utils.py)
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1280; // 80ms
const MEL_BINS = 32;
const EMBEDDING_DIM = 96;
const EMBEDDING_WINDOW = 76; // mel frames per embedding
const MEL_BUFFER_MAX = 970; // ~10 seconds
const FEATURE_BUFFER_MAX = 120;
const MODEL_INPUT_FRAMES = 16;
const RAW_BUFFER_MAX = SAMPLE_RATE * 10; // 10 seconds

// VAD
const VAD_FRAME_SIZE = 480; // 30ms
const VAD_THRESHOLD = 0.15;

// Confidence stacking
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
  let warmupFrames = 5;

  // Raw audio buffer (circular, like Python's deque(maxlen=sr*10))
  let rawBuffer = new Int16Array(RAW_BUFFER_MAX);
  let rawBufferLen = 0;

  // Remainder from incomplete chunks
  let rawRemainder = new Int16Array(0);
  let accumulatedSamples = 0;

  // Mel buffer: initialized with ONES (matching Python)
  let melBuffer = new Float32Array(MEL_BUFFER_MAX * MEL_BINS).fill(1.0);
  let melRows = EMBEDDING_WINDOW; // Start at 76 (Python inits with ones((76,32)))

  // Feature buffer
  let featureBuffer = new Float32Array(FEATURE_BUFFER_MAX * EMBEDDING_DIM);
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
  async function computeMelspec(audioInt16: Int16Array): Promise<Float32Array> {
    // Convert to float32 (matching Python: x.astype(np.float32))
    const audioFloat = new Float32Array(audioInt16.length);
    for (let i = 0; i < audioInt16.length; i++) {
      audioFloat[i] = audioInt16[i];
    }

    const results = await melspecSession.run({
      input: new ort.Tensor("float32", audioFloat, [1, audioFloat.length]),
    });
    const output = results[Object.keys(results)[0]] as ort.Tensor;

    // Output is (1, 1, frames, 32) — squeeze to (frames, 32)
    const rawData = new Float32Array(output.data as Float32Array);

    // Transform: output / 10.0 + 2.0 (matching Python default)
    for (let i = 0; i < rawData.length; i++) {
      rawData[i] = rawData[i] / 10.0 + 2.0;
    }

    return rawData;
  }

  // ---- Embedding ----
  async function computeEmbedding(melWindow: Float32Array): Promise<Float32Array> {
    // Input: (1, 76, 32, 1) matching Python's [None, :, :, None]
    const results = await embeddingSession.run({
      input_1: new ort.Tensor("float32", melWindow, [1, EMBEDDING_WINDOW, MEL_BINS, 1]),
    });
    const output = results[Object.keys(results)[0]] as ort.Tensor;
    // Python does .squeeze() — output is (96,) or (1, 96)
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

  // ---- Add raw audio to buffer (matching Python _buffer_raw_data) ----
  function bufferRawData(data: Int16Array) {
    if (rawBufferLen + data.length > RAW_BUFFER_MAX) {
      // Shift: keep last portion
      const keep = RAW_BUFFER_MAX - data.length;
      rawBuffer.copyWithin(0, rawBufferLen - keep, rawBufferLen);
      rawBufferLen = keep;
    }
    rawBuffer.set(data, rawBufferLen);
    rawBufferLen += data.length;
  }

  // ---- Streaming melspectrogram (matching Python _streaming_melspectrogram) ----
  async function streamingMelspectrogram(nSamples: number) {
    // Python: list(self.raw_data_buffer)[-n_samples - 160*3:]
    // Take last (nSamples + 480) samples from raw buffer for context overlap
    const contextSamples = nSamples + 160 * 3;
    const startIdx = Math.max(0, rawBufferLen - contextSamples);
    const audioSlice = rawBuffer.slice(startIdx, rawBufferLen);

    const melFrames = await computeMelspec(new Int16Array(audioSlice.buffer, audioSlice.byteOffset, audioSlice.length));
    const newRows = melFrames.length / MEL_BINS;

    // Append to mel buffer (matching Python np.vstack)
    if (melRows + newRows > MEL_BUFFER_MAX) {
      // Shift: keep last portion
      const keep = MEL_BUFFER_MAX - newRows;
      melBuffer.copyWithin(0, (melRows - keep) * MEL_BINS, melRows * MEL_BINS);
      melRows = keep;
    }
    melBuffer.set(melFrames, melRows * MEL_BINS);
    melRows += newRows;
  }

  // ---- Main predict (matching Python _streaming_features) ----
  async function predict(pcm: Int16Array): Promise<WakeWordResult> {
    const none: WakeWordResult = { detected: false, score: 0, vadScore: 0 };
    if (!listening) return none;

    // VAD (doesn't block pipeline)
    const vadScore = await runVad(pcm);

    // Prepend remainder
    let x: Int16Array;
    if (rawRemainder.length > 0) {
      x = new Int16Array(rawRemainder.length + pcm.length);
      x.set(rawRemainder);
      x.set(pcm, rawRemainder.length);
      rawRemainder = new Int16Array(0);
    } else {
      x = pcm;
    }

    // Split into even chunks (matching Python logic)
    if (accumulatedSamples + x.length >= CHUNK_SAMPLES) {
      const totalSamples = accumulatedSamples + x.length;
      const remainder = totalSamples % CHUNK_SAMPLES;
      if (remainder !== 0) {
        const evenPart = x.slice(0, x.length - remainder);
        bufferRawData(evenPart);
        accumulatedSamples += evenPart.length;
        rawRemainder = x.slice(x.length - remainder);
      } else {
        bufferRawData(x);
        accumulatedSamples += x.length;
        rawRemainder = new Int16Array(0);
      }
    } else {
      accumulatedSamples += x.length;
      bufferRawData(x);
      return none;
    }

    // Only process when we have accumulated full chunks
    if (accumulatedSamples >= CHUNK_SAMPLES && accumulatedSamples % CHUNK_SAMPLES === 0) {
      // Compute melspectrogram with context overlap
      await streamingMelspectrogram(accumulatedSamples);

      // Compute embeddings (matching Python loop)
      // Compute embeddings (matching Python: for i in np.arange(accumulated//1280-1, -1, -1))
      const nChunks = accumulatedSamples / CHUNK_SAMPLES;
      for (let i = nChunks - 1; i >= 0; i--) {
        // Python: ndx = -8*i; ndx = ndx if ndx != 0 else len(mel_buffer)
        // Then: mel_buffer[-76 + ndx : ndx]
        // This gives the last 76 frames offset by 8*i from the end
        const offset = 8 * i; // frames back from end
        const endMel = melRows - offset;
        const startMel = endMel - EMBEDDING_WINDOW;

        // Check bounds (matching Python: if x.shape[1] == 76)
        if (startMel < 0 || endMel > melRows || endMel - startMel !== EMBEDDING_WINDOW) {
          continue;
        }

        const melWindow = melBuffer.slice(startMel * MEL_BINS, endMel * MEL_BINS);
        const embedding = await computeEmbedding(new Float32Array(melWindow));

        // Append to feature buffer
        if (featureRows >= FEATURE_BUFFER_MAX) {
          featureBuffer.copyWithin(0, EMBEDDING_DIM, featureRows * EMBEDDING_DIM);
          featureRows = FEATURE_BUFFER_MAX - 1;
        }
        featureBuffer.set(embedding.subarray(0, EMBEDDING_DIM), featureRows * EMBEDDING_DIM);
        featureRows++;
      }

      // Reset accumulated (matching Python: self.accumulated_samples = 0)
      accumulatedSamples = 0;
    }

    // Trim feature buffer
    if (featureRows > FEATURE_BUFFER_MAX) {
      featureBuffer.copyWithin(0, (featureRows - FEATURE_BUFFER_MAX) * EMBEDDING_DIM, featureRows * EMBEDDING_DIM);
      featureRows = FEATURE_BUFFER_MAX;
    }

    // Need enough features
    if (featureRows < MODEL_INPUT_FRAMES) {
      return { detected: false, score: 0, vadScore };
    }

    // Warm-up skip
    if (warmupFrames > 0) {
      warmupFrames--;
      return { detected: false, score: 0, vadScore };
    }

    // Get last MODEL_INPUT_FRAMES embeddings (matching Python get_features)
    const startF = (featureRows - MODEL_INPUT_FRAMES) * EMBEDDING_DIM;
    const features = featureBuffer.slice(startF, startF + MODEL_INPUT_FRAMES * EMBEDDING_DIM);

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
    vadH.fill(0);
    vadC.fill(0);
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

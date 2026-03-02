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

  // Confidence stacking
  // We explicitly match the exact openWakeWord python buffering behavior
  // Python has debounce_time, patience, etc.
  const STACK_WINDOW = 5;
  const STACK_REQUIRED = 3;
  const COOLDOWN_MS = 1000;
  const WARMUP_FRAMES = 0;

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

  const modelPaths = {
    melspec: path.join(modelDir, "melspectrogram.onnx"),
    embedding: path.join(modelDir, "embedding_model.onnx"),
    wakeword: path.join(modelDir, "stella_wakeword.onnx"),
    vad: path.join(modelDir, "silero_vad.onnx"),
  };

  // Sessions are created once during initialization.
  // The DML execution provider bug was resolved by enforcing strictly static tensor shapes
  // (always passing exactly [1, 1760] to the melspectrogram).
  let melspecSession: ort.InferenceSession;
  let embeddingSession: ort.InferenceSession;
  let wakewordSession: ort.InferenceSession;
  let vadSession: ort.InferenceSession;

  // Pre-compute silence embedding to fill buffers during VAD pauses.
  // This prevents the neural network from seeing out-of-distribution zero-padding
  // and smoothly bridges the context without breaking the chronological timeline.
  let silenceEmbedding = new Float32Array(EMBEDDING_DIM);

  async function createAllSessions() {
    [melspecSession, embeddingSession, wakewordSession, vadSession] =
      await Promise.all([
        ort.InferenceSession.create(modelPaths.melspec, opts),
        ort.InferenceSession.create(modelPaths.embedding, opts),
        ort.InferenceSession.create(modelPaths.wakeword, opts),
        ort.InferenceSession.create(modelPaths.vad, opts),
      ]);

    // Compute the embedding of pure silence (1.0 mel bins)
    const silenceMelWindow = new Float32Array(EMBEDDING_WINDOW * MEL_BINS).fill(1.0);
    const results = await embeddingSession.run({
      input_1: new ort.Tensor("float32", silenceMelWindow, [1, EMBEDDING_WINDOW, MEL_BINS, 1]),
    });
    const output = results[Object.keys(results)[0]] as ort.Tensor;
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

  // State
  let listening = false;
  let threshold = DEFAULT_THRESHOLD;
  let lastActivationTime = 0;
  let warmupFrames = WARMUP_FRAMES;

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

  // VAD Hangover: keep processing heavy models for a while after speech stops
  const VAD_HANGOVER_FRAMES = 15; // 15 * 80ms = 1.2 seconds
  let vadHangover = 0;

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
    // ALWAYS pass exactly (nSamples + MEL_CONTEXT_SAMPLES) to avoid dynamic shapes.
    // Dynamic shapes on Windows DirectML cause pipeline recompilation and silent 
    // memory corruption/zero-tensor outputs across detection cycles.
    const contextSamples = nSamples + MEL_CONTEXT_SAMPLES;
    const audioFloat = new Float32Array(contextSamples);
    
    // Copy available samples to the END of the array (implicitly zero-padding the start)
    const available = Math.min(rawBufferLen, contextSamples);
    const startIdx = rawBufferLen - available;
    
    for (let i = 0; i < available; i++) {
      audioFloat[contextSamples - available + i] = rawBuffer[startIdx + i];
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
    
    // NOTE: melRows starts at 76, so if we just append, the first melspec goes to row 76
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
    // Debug: check if features are all-zero (would produce score=0)
    let nonZero = 0;
    for (let i = 0; i < features.length; i++) {
      if (features[i] !== 0) { nonZero++; break; }
    }
    if (nonZero === 0 && featureRows > 0) {
      console.warn(`[WakeWord:dbg] classifier input is ALL ZEROS despite featureRows=${featureRows}`);
    }
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

  let chunkDbg = 0;

  // ---- Main predict (matching Python _streaming_features + predict) ----
  async function predict(pcm: Int16Array): Promise<WakeWordResult> {
    const none: WakeWordResult = { detected: false, score: 0, vadScore: 0 };
    if (!listening) return none;

    // ── Gate 1: RMS ──
    const rms = computeRms(pcm);
    const isLoud = rms >= RMS_THRESHOLD;

    if (isLoud && chunkDbg % 10 === 0) {
      console.log(`[WakeWord] RMS=${Math.round(rms)} (threshold=${RMS_THRESHOLD}) — audio active`);
    }

    // Always run VAD when audio is loud, OR when we are in a hangover period
    let vadScore = 0;
    if (isLoud || vadHangover > 0) {
      vadScore = await runVad(pcm);
      if (vadScore >= VAD_THRESHOLD) {
        vadHangover = VAD_HANGOVER_FRAMES;
      } else if (vadHangover > 0) {
        vadHangover--;
      }
    }

    // We are in a prolonged silence. Check if we need to reset the state.
    // If featureRows > MODEL_INPUT_FRAMES, it means speech recently happened and finished.
    // We seamlessly switch to "silence embeddings" without a discontinuous timeline drop.
    if (!isLoud && vadHangover === 0) {
      bufferRawData(pcm);
      if (featureRows > MODEL_INPUT_FRAMES || accumulatedSamples > 0) {
        resetToSilence();
      }
      return { detected: false, score: 0, vadScore };
    }

    // Always buffer raw audio (needed for mel context overlap)
    // We do this BEFORE the vadHangover check so that if we DO process the audio,
    // we have it buffered properly.
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

    // VAD gate: skip expensive mel/embedding/classifier if not speech/hangover
    // We rely on vadHangover to bridge short pauses in speech.
    if (vadHangover === 0) {
      // Return 0 for score since we didn't run the classifier
      return { detected: false, score: 0, vadScore };
    }

    // ── Mel + Embedding + Classifier (only runs on speech) ──
    if (chunkDbg++ < 40) {
      console.log(`[WakeWord:dbg] pcm=${pcm.length} accum=${accumulatedSamples} melRows=${melRows} featRows=${featureRows} rawBufLen=${rawBufferLen}`);
    }

    // ── Mel + Embedding + Classifier (only runs on speech) ──
    // Wait for accumulated samples to reach the threshold before calculating
    if (accumulatedSamples >= CHUNK_SAMPLES) {
      // Because we check >= CHUNK_SAMPLES, we need to ensure we process only integer chunks.
      // E.g., if accumulatedSamples is 2560, we process 2560.
      // If accumulatedSamples is 1280, we process 1280.
      const nChunks = Math.floor(accumulatedSamples / CHUNK_SAMPLES);
      const samplesToProcess = nChunks * CHUNK_SAMPLES;

      // Streaming mel with context overlap
      await streamingMelspec(samplesToProcess);

      // Compute embeddings (matching Python loop)
      // We must calculate the embeddings in chronological order so that the features array
      // receives the oldest frames first and the newest frames last!
      // In python they looped backwards because they vstack'd to a matrix where the end is the newest.
      for (let i = 0; i < nChunks; i++) {
        // i=0 is the oldest chunk, i=nChunks-1 is the newest chunk
        const offset = 8 * (nChunks - 1 - i);
        
        // This is perfectly matching the Python logic.
        // E.g., if accumulatedSamples=1280 (1 chunk), nChunks=1. i=0, offset=0.
        // If accumulatedSamples=2560 (2 chunks), nChunks=2.
        // i=1 (offset=8), i=0 (offset=0).
        // Since we update melRows *after* getting mel specs but *before* this loop,
        // melRows is the current end. 
        const endMel = melRows - offset;
        const startMel = endMel - EMBEDDING_WINDOW;

        if (startMel < 0 || endMel > melRows) {
          continue;
        }

        // Copy the specific window from the full mel buffer using slice() for native speed
        const melWindow = melBuffer.slice(startMel * MEL_BINS, endMel * MEL_BINS);
        
        // Ensure shape is strictly [1, 76, 32, 1] for the DML provider
        const embedding = await computeEmbedding(melWindow);

        if (featureRows >= FEATURE_BUFFER_MAX) {
          featureBuffer.copyWithin(0, EMBEDDING_DIM, featureRows * EMBEDDING_DIM);
          featureRows = FEATURE_BUFFER_MAX - 1;
        }
        
        // Only set the FIRST 96 dimensions (the output of the embedding is shape [1, 1, 96])
        featureBuffer.set(embedding.subarray(0, EMBEDDING_DIM), featureRows * EMBEDDING_DIM);
        featureRows++;
      }

      accumulatedSamples = accumulatedSamples - samplesToProcess;
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
    // OpenWakeWord zero-pads predictions for first 5 frames to prevent early misfires
    const finalScore = featureRows < 5 ? 0.0 : score;

    if (chunkDbg < 25 && finalScore < 0.01 && featureRows >= 5) {
      // Check if features are populated
      let sum = 0;
      for (let j = 0; j < features.length; j++) sum += Math.abs(features[j]);
      console.log(`[WakeWord:dbg] score=${finalScore.toFixed(4)} featSum=${sum.toFixed(2)} available=${available} srcStart=${(featureRows - available) * EMBEDDING_DIM} dstStart=${(MODEL_INPUT_FRAMES - available) * EMBEDDING_DIM}`);
    }

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

  // ---- Reset ----
  function resetToSilence() {
    melBuffer.fill(1.0);
    melRows = EMBEDDING_WINDOW; 
    
    // Fill the first 16 frames with the pre-computed silence embedding
    // This allows the neural network to seamlessly bridge background silence into speech
    // exactly like the python openWakeWord library does
    for (let i = 0; i < MODEL_INPUT_FRAMES; i++) {
      featureBuffer.set(silenceEmbedding, i * EMBEDDING_DIM);
    }
    featureRows = MODEL_INPUT_FRAMES;
    
    accumulatedSamples = 0;
    rawRemainder = new Int16Array(0);
    recentScores.length = 0;
    
    vadState.fill(0);
    vadContext.fill(0);
    vadHangover = 0;
  }

  function resetState() {
    rawBufferLen = 0;
    rawBuffer.fill(0);
    
    resetToSilence();
    
    warmupFrames = WARMUP_FRAMES;
    chunkDbg = 0; // Keep logging neat
  }

  return {
    async start() {
      listening = true;
      lastActivationTime = 0;
      chunkDbg = 0;
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
      releaseAllSessions();
    },
  };
}

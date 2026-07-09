// Copyright 2026 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use ndarray::{Array1, Axis};
use ort::session::Session;
use ort::value::Tensor;
use resampler::{Attenuation, Latency, ResamplerFir, SampleRate};

use crate::embedding::EmbeddingModel;
use crate::melspectrogram::MelspectrogramModel;
use crate::{
    build_session_from_file, to_resampler_rate, WakeWordError, EMBEDDING_STRIDE, EMBEDDING_WINDOW,
    MIN_EMBEDDINGS,
};

const MAX_EMBEDDING_CACHE_WINDOWS: usize = MIN_EMBEDDINGS * 2;

struct CachedEmbedding {
    key: u64,
    fingerprint: Vec<u32>,
    embedding: Array1<f32>,
}

struct Resampler {
    fir: ResamplerFir,
    output_buf: Vec<f32>,
    input_rate: u32,
}

/// Wake word detection model with optional input resampling.
///
/// The mel spectrogram and speech embedding models are bundled at compile time.
/// Wake word classifier models are loaded dynamically from disk at runtime.
///
/// Pass ~2 seconds of i16 PCM audio at the configured sample rate to
/// [`predict`](Self::predict) and receive per-classifier confidence scores.
pub struct WakeWordModel {
    mel_model: MelspectrogramModel,
    emb_model: EmbeddingModel,
    classifiers: HashMap<String, Session>,
    resampler: Option<Resampler>,
    embedding_cache: VecDeque<CachedEmbedding>,
}

impl WakeWordModel {
    /// Create a new wake word model.
    ///
    /// The recommended sample rate is 16 kHz. Other supported rates
    /// (22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000, 384000 Hz)
    /// are resampled internally to 16 kHz.
    pub fn new(models: &[impl AsRef<Path>], sample_rate: u32) -> Result<Self, WakeWordError> {
        let resampler = if sample_rate != 16000 {
            let input_rate = to_resampler_rate(sample_rate)?;
            // FIR resampler: 64-sample latency (~1.3ms at 48kHz) with 90dB
            // stopband attenuation to match the quality of training data.
            let fir = ResamplerFir::new(
                1,
                input_rate,
                SampleRate::Hz16000,
                Latency::Sample64,
                Attenuation::Db90,
            );
            let output_buf = vec![0.0f32; fir.buffer_size_output()];
            Some(Resampler {
                fir,
                output_buf,
                input_rate: sample_rate,
            })
        } else {
            None
        };

        let mut wakeword = Self {
            mel_model: MelspectrogramModel::new()?,
            emb_model: EmbeddingModel::new()?,
            classifiers: HashMap::new(),
            resampler,
            embedding_cache: VecDeque::with_capacity(MAX_EMBEDDING_CACHE_WINDOWS),
        };

        for path in models {
            wakeword.load_model(path, None)?;
        }

        Ok(wakeword)
    }

    /// Load a wake word classifier ONNX model from disk.
    ///
    /// If `model_name` is `None`, the file stem is used as the classifier name.
    pub fn load_model(
        &mut self,
        model_path: impl AsRef<Path>,
        model_name: Option<&str>,
    ) -> Result<(), WakeWordError> {
        let path = model_path.as_ref();
        if !path.exists() {
            return Err(WakeWordError::ModelNotFound(path.display().to_string()));
        }

        let name = match model_name {
            Some(n) => n.to_string(),
            None => path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string(),
        };

        let session = build_session_from_file(path)?;
        self.classifiers.insert(name, session);
        Ok(())
    }

    fn resample_to_16k(&mut self, samples: &[i16]) -> Result<Vec<f32>, WakeWordError> {
        let rs = self.resampler.as_mut().unwrap();

        let input: Vec<f32> = samples.iter().map(|&x| x as f32 / 32768.0).collect();
        let mut output = Vec::with_capacity(
            (input.len() as f64 * 16000.0 / rs.input_rate as f64).ceil() as usize,
        );

        let mut pos = 0;
        while pos < input.len() {
            let (consumed, produced) = rs.fir.resample(&input[pos..], &mut rs.output_buf)?;
            output.extend_from_slice(&rs.output_buf[..produced]);
            pos += consumed;
            if consumed == 0 && produced == 0 {
                break;
            }
        }

        Ok(output)
    }

    /// Get wake word predictions for an audio chunk.
    ///
    /// Pass ~2 seconds of i16 PCM audio at the sample rate configured in
    /// [`new`](Self::new). Shorter chunks that produce fewer than
    /// [`MIN_EMBEDDINGS`] embeddings return zero scores.
    pub fn predict(&mut self, audio_chunk: &[i16]) -> Result<HashMap<String, f32>, WakeWordError> {
        if self.classifiers.is_empty() {
            return Ok(HashMap::new());
        }

        // Resample if needed, then normalize to f32
        let samples_f32 = if self.resampler.is_some() {
            self.resample_to_16k(audio_chunk)?
        } else {
            audio_chunk.iter().map(|&x| x as f32 / 32768.0).collect()
        };

        // Mel spectrogram over the full chunk
        let mel = self.mel_model.detect(&samples_f32)?;
        let num_frames = mel.shape()[0];

        if num_frames < EMBEDDING_WINDOW {
            return Ok(self.zero_scores());
        }

        // Extract embeddings: 76-frame windows, stride 8
        let mut embeddings = Vec::new();
        let mut start = 0;
        while start + EMBEDDING_WINDOW <= num_frames {
            let window = mel.slice(ndarray::s![start..start + EMBEDDING_WINDOW, ..]);
            let window_slice = window.as_standard_layout();
            let emb = self.embedding_for_window(window_slice.as_slice().unwrap())?;
            embeddings.push(emb);
            start += EMBEDDING_STRIDE;
        }

        if embeddings.len() < MIN_EMBEDDINGS {
            return Ok(self.zero_scores());
        }

        // Use last MIN_EMBEDDINGS embeddings -> shape (1, 16, 96)
        let last = &embeddings[embeddings.len() - MIN_EMBEDDINGS..];
        let views: Vec<_> = last.iter().map(|e| e.view()).collect();
        let emb_sequence = ndarray::stack(Axis(0), &views)?;
        let emb_input = emb_sequence.insert_axis(Axis(0));

        // Run each classifier
        let mut predictions = HashMap::new();
        for (name, session) in &mut self.classifiers {
            let tensor = Tensor::from_array(emb_input.clone())?;
            let outputs = session.run(ort::inputs!["embeddings" => tensor])?;
            let raw = outputs["score"].try_extract_array::<f32>()?;
            let score = raw.iter().copied().next().unwrap_or(0.0);
            predictions.insert(name.clone(), score);
        }

        Ok(predictions)
    }

    fn zero_scores(&self) -> HashMap<String, f32> {
        self.classifiers.keys().map(|k| (k.clone(), 0.0)).collect()
    }

    fn embedding_for_window(&mut self, mel_features: &[f32]) -> Result<Array1<f32>, WakeWordError> {
        let fingerprint: Vec<u32> = mel_features.iter().map(|value| value.to_bits()).collect();
        let key = fingerprint_hash(&fingerprint);
        if let Some(cached) = self
            .embedding_cache
            .iter()
            .find(|cached| cached.key == key && cached.fingerprint == fingerprint)
        {
            return Ok(cached.embedding.clone());
        }

        let embedding = self.emb_model.detect(mel_features)?;
        self.embedding_cache.push_back(CachedEmbedding {
            key,
            fingerprint,
            embedding: embedding.clone(),
        });
        while self.embedding_cache.len() > MAX_EMBEDDING_CACHE_WINDOWS {
            self.embedding_cache.pop_front();
        }
        Ok(embedding)
    }
}

fn fingerprint_hash(values: &[u32]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for &value in values {
        hash ^= value as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// ---------------------------------------------------------------------------
// Streaming (incremental) prediction
//
// Profiling the active path showed the speech-embedding model dominates cost
// (~16 window evaluations per prediction), while the mel front-end and the
// classifier are comparatively cheap. When the rolling window advances by one
// embedding stride between predictions, 15 of the 16 embedding windows are
// unchanged, yet the stock `predict` recomputes all of them every call and the
// content-fingerprint cache misses because tiny mel boundary drift perturbs the
// exact bytes. `predict_stream` keeps the mel identical to `predict` but caches
// embeddings by their absolute start-sample, so steady-state work drops to about
// one embedding evaluation per call.
// ---------------------------------------------------------------------------

/// Rolling window length fed to the mel front-end (2 s @ 16 kHz).
const STREAM_WINDOW_SAMPLES: usize = 32_000;
/// Mel hop in samples (10 ms): frame `i` covers raw `[i*HOP, i*HOP + 512)`.
const STREAM_MEL_HOP: i64 = 160;
/// One embedding window advances `EMBEDDING_STRIDE` mel frames of raw audio.
const STREAM_WINDOW_ADVANCE: i64 = EMBEDDING_STRIDE as i64 * STREAM_MEL_HOP; // 1280

/// Rolling state for [`WakeWordModel::predict_stream`]. One per audio stream.
pub struct StreamState {
    ring: Vec<i16>,
    total_samples: i64,
    /// (absolute start-sample of the 76-frame window, embedding).
    emb_cache: VecDeque<(i64, Array1<f32>)>,
    reuse_hits: u64,
    compute_misses: u64,
}

impl Default for StreamState {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamState {
    pub fn new() -> Self {
        Self {
            ring: Vec::with_capacity(STREAM_WINDOW_SAMPLES + 4096),
            total_samples: 0,
            emb_cache: VecDeque::with_capacity(MIN_EMBEDDINGS * 3),
            reuse_hits: 0,
            compute_misses: 0,
        }
    }

    /// Drop all buffered audio and cached embeddings (e.g. after a detection).
    pub fn reset(&mut self) {
        self.ring.clear();
        self.total_samples = 0;
        self.emb_cache.clear();
    }

    /// Embeddings reused from cache vs recomputed, since construction.
    pub fn cache_stats(&self) -> (u64, u64) {
        (self.reuse_hits, self.compute_misses)
    }
}

impl WakeWordModel {
    /// Streaming counterpart to [`predict`](Self::predict).
    ///
    /// Feed the 16 kHz mono i16 samples captured since the previous call. The
    /// returned scores are computed over the most recent ~2 s, identical in
    /// meaning to `predict`, but embeddings whose absolute audio window has not
    /// changed are reused instead of recomputed.
    pub fn predict_stream(
        &mut self,
        state: &mut StreamState,
        new_audio: &[i16],
    ) -> Result<HashMap<String, f32>, WakeWordError> {
        if self.classifiers.is_empty() {
            return Ok(HashMap::new());
        }

        state.ring.extend_from_slice(new_audio);
        state.total_samples += new_audio.len() as i64;
        if state.ring.len() > STREAM_WINDOW_SAMPLES {
            let drop = state.ring.len() - STREAM_WINDOW_SAMPLES;
            state.ring.drain(..drop);
        }
        let base_sample = state.total_samples - state.ring.len() as i64;

        let samples_f32: Vec<f32> = state.ring.iter().map(|&x| x as f32 / 32768.0).collect();
        let mel = self.mel_model.detect(&samples_f32)?;
        let num_frames = mel.shape()[0];
        if num_frames < EMBEDDING_WINDOW {
            return Ok(self.zero_scores());
        }
        let n_windows = (num_frames - EMBEDDING_WINDOW) / EMBEDDING_STRIDE + 1;
        if n_windows < MIN_EMBEDDINGS {
            return Ok(self.zero_scores());
        }

        let first = n_windows - MIN_EMBEDDINGS;
        let oldest_key = base_sample + first as i64 * STREAM_WINDOW_ADVANCE;
        while let Some(&(k, _)) = state.emb_cache.front() {
            if k < oldest_key {
                state.emb_cache.pop_front();
            } else {
                break;
            }
        }

        let mut seq: Vec<Array1<f32>> = Vec::with_capacity(MIN_EMBEDDINGS);
        for w in first..n_windows {
            let key = base_sample + w as i64 * STREAM_WINDOW_ADVANCE;
            if let Some((_, e)) = state.emb_cache.iter().find(|(k, _)| *k == key) {
                state.reuse_hits += 1;
                seq.push(e.clone());
                continue;
            }
            let start = w * EMBEDDING_STRIDE;
            let window = mel.slice(ndarray::s![start..start + EMBEDDING_WINDOW, ..]);
            let window_slice = window.as_standard_layout();
            let emb = self.emb_model.detect(window_slice.as_slice().unwrap())?;
            state.compute_misses += 1;
            state.emb_cache.push_back((key, emb.clone()));
            seq.push(emb);
        }
        while state.emb_cache.len() > MIN_EMBEDDINGS * 3 {
            state.emb_cache.pop_front();
        }

        let views: Vec<_> = seq.iter().map(|e| e.view()).collect();
        let emb_sequence = ndarray::stack(Axis(0), &views)?;
        let emb_input = emb_sequence.insert_axis(Axis(0));

        let mut predictions = HashMap::new();
        for (name, session) in &mut self.classifiers {
            let tensor = Tensor::from_array(emb_input.clone())?;
            let outputs = session.run(ort::inputs!["embeddings" => tensor])?;
            let raw = outputs["score"].try_extract_array::<f32>()?;
            let score = raw.iter().copied().next().unwrap_or(0.0);
            predictions.insert(name.clone(), score);
        }
        Ok(predictions)
    }
}

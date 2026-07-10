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
// Fixed-lattice streaming prediction
//
// Audio callbacks and classifier predictions have unrelated cadences. Tying
// embedding keys to the start of each rolling prediction window therefore loses
// all reuse whenever that window advances by a non-1280-sample amount (120 ms is
// 1920 samples). Instead, incoming audio advances a fixed 160-sample mel-frame
// lattice. Every eight new frames produce exactly one embedding on a fixed
// 1280-sample lattice, and prediction only reads the latest 16 embeddings.
// ---------------------------------------------------------------------------

/// Mel hop in samples (10 ms): frame `i` covers raw `[i*HOP, i*HOP + 512)`.
const STREAM_MEL_HOP: u64 = 160;
/// Rolling model window (2 s at 16 kHz), always aligned to the lattice.
const STREAM_WINDOW_SAMPLES: usize = 32_000;
/// One embedding advances eight mel frames (80 ms at 16 kHz).
const STREAM_EMBEDDING_ADVANCE: u64 = EMBEDDING_STRIDE as u64 * STREAM_MEL_HOP;

/// Fixed-lattice state for one 16 kHz mono audio stream.
pub struct StreamState {
    audio: Vec<i16>,
    audio_start_sample: u64,
    total_samples: u64,
    next_window_start_sample: u64,
    /// (absolute start sample, embedding), always on the 1280-sample lattice.
    embeddings: VecDeque<(u64, Array1<f32>)>,
    embeddings_since_predict: usize,
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
            audio: Vec::with_capacity(STREAM_WINDOW_SAMPLES + 4096),
            audio_start_sample: 0,
            total_samples: 0,
            next_window_start_sample: 0,
            embeddings: VecDeque::with_capacity(MIN_EMBEDDINGS + 1),
            embeddings_since_predict: 0,
            reuse_hits: 0,
            compute_misses: 0,
        }
    }

    /// Drop all buffered audio and cached embeddings (e.g. after a detection).
    pub fn reset(&mut self) {
        self.audio.clear();
        self.audio_start_sample = 0;
        self.total_samples = 0;
        self.next_window_start_sample = 0;
        self.embeddings.clear();
        self.embeddings_since_predict = 0;
    }

    /// Classifier embedding slots reused vs embeddings computed, since construction.
    pub fn cache_stats(&self) -> (u64, u64) {
        (self.reuse_hits, self.compute_misses)
    }
}

impl WakeWordModel {
    /// Advance mel and embedding state with newly captured 16 kHz mono audio.
    ///
    /// This is intentionally separate from [`predict_stream`](Self::predict_stream):
    /// callback sizes and prediction cadence cannot change the 160/1280-sample
    /// lattice. Mel calls stay on aligned 2-second windows for tensor parity,
    /// while each speech embedding is computed exactly once.
    pub fn advance_stream(
        &mut self,
        state: &mut StreamState,
        new_audio: &[i16],
    ) -> Result<(), WakeWordError> {
        if self.classifiers.is_empty() {
            return Ok(());
        }

        state.audio.extend_from_slice(new_audio);
        state.total_samples += new_audio.len() as u64;

        while state.total_samples
            >= state.next_window_start_sample + STREAM_WINDOW_SAMPLES as u64
        {
            let offset =
                (state.next_window_start_sample - state.audio_start_sample) as usize;
            let samples_f32: Vec<f32> = state.audio[offset..offset + STREAM_WINDOW_SAMPLES]
                .iter()
                .map(|&sample| sample as f32 / 32768.0)
                .collect();
            let mel = self.mel_model.detect(&samples_f32)?;
            let num_frames = mel.shape()[0];
            let num_windows = (num_frames - EMBEDDING_WINDOW) / EMBEDDING_STRIDE + 1;
            let first_window = if state.embeddings.is_empty() {
                num_windows - MIN_EMBEDDINGS
            } else {
                num_windows - 1
            };
            for window_index in first_window..num_windows {
                let start_frame = window_index * EMBEDDING_STRIDE;
                let window = mel.slice(ndarray::s![
                    start_frame..start_frame + EMBEDDING_WINDOW,
                    ..
                ]);
                let window = window.as_standard_layout();
                let embedding = self.emb_model.detect(window.as_slice().unwrap())?;
                let start_sample = state.next_window_start_sample
                    + window_index as u64 * STREAM_EMBEDDING_ADVANCE;
                state.embeddings.push_back((start_sample, embedding));
                if state.embeddings.len() > MIN_EMBEDDINGS {
                    state.embeddings.pop_front();
                }
                state.embeddings_since_predict += 1;
                state.compute_misses += 1;
            }

            state.next_window_start_sample += STREAM_EMBEDDING_ADVANCE;
            let drop_samples =
                (state.next_window_start_sample - state.audio_start_sample) as usize;
            state.audio.drain(..drop_samples);
            state.audio_start_sample = state.next_window_start_sample;
        }
        Ok(())
    }

    /// Classify the latest 16 fixed-lattice embeddings without advancing audio.
    pub fn predict_stream(
        &mut self,
        state: &mut StreamState,
    ) -> Result<HashMap<String, f32>, WakeWordError> {
        if self.classifiers.is_empty() {
            return Ok(HashMap::new());
        }
        if state.embeddings.len() < MIN_EMBEDDINGS {
            return Ok(self.zero_scores());
        }

        let newly_computed = state.embeddings_since_predict.min(MIN_EMBEDDINGS);
        state.reuse_hits += (MIN_EMBEDDINGS - newly_computed) as u64;
        state.embeddings_since_predict = 0;

        let views: Vec<_> = state
            .embeddings
            .iter()
            .map(|(_, embedding)| embedding.view())
            .collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn classifier_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("hey_livekit.onnx")
    }

    fn signal(samples: usize) -> Vec<i16> {
        (0..samples)
            .map(|i| {
                let t = i as f32 / crate::SAMPLE_RATE as f32;
                let frequency = 190.0 + 140.0 * (0.61 * t).sin();
                let amplitude = 0.18 + 0.12 * (0.27 * t).sin();
                ((amplitude * (2.0 * std::f32::consts::PI * frequency * t).sin())
                    * i16::MAX as f32) as i16
            })
            .collect()
    }

    #[test]
    fn fixed_lattice_matches_per_callback_embeddings_and_scores() {
        let audio = signal(96_000);
        let callback_sizes = [512usize, 480, 640, 384, 704, 512];
        let prediction_stride = 1_920usize;
        let mut stream_model = WakeWordModel::new(&[classifier_path()], 16_000).unwrap();
        let mut reference_model = WakeWordModel::new(&[classifier_path()], 16_000).unwrap();
        let mut legacy_model = WakeWordModel::new(&[classifier_path()], 16_000).unwrap();
        let mut state = StreamState::new();
        let mut reference_state = StreamState::new();
        let mut reference_embeddings = VecDeque::with_capacity(MIN_EMBEDDINGS + 1);
        let mut next_reference_window_start = 0u64;
        let mut position = 0usize;
        let mut callback = 0usize;
        let mut since_predict = 0usize;
        let mut comparisons = 0usize;
        let mut max_embedding_diff = 0.0f32;
        let mut max_score_diff = 0.0f32;
        let mut max_legacy_score_diff = 0.0f32;

        while position < audio.len() {
            let count = callback_sizes[callback % callback_sizes.len()]
                .min(audio.len() - position);
            callback += 1;
            stream_model
                .advance_stream(&mut state, &audio[position..position + count])
                .unwrap();
            position += count;
            since_predict += count;

            // Reference path: at every fixed lattice point, run the original
            // full-window mel + all-embedding computation with no reuse. Keep
            // only the newest embedding after the initial 16, exactly as the
            // reorganized lattice should do incrementally.
            while position as u64
                >= next_reference_window_start + STREAM_WINDOW_SAMPLES as u64
            {
                let start = next_reference_window_start as usize;
                let normalized: Vec<f32> = audio[start..start + STREAM_WINDOW_SAMPLES]
                    .iter()
                    .map(|&sample| sample as f32 / 32768.0)
                    .collect();
                let mel = reference_model.mel_model.detect(&normalized).unwrap();
                let num_windows =
                    (mel.shape()[0] - EMBEDDING_WINDOW) / EMBEDDING_STRIDE + 1;
                let mut callback_embeddings = Vec::with_capacity(num_windows);
                for index in 0..num_windows {
                    let frame = index * EMBEDDING_STRIDE;
                    let window =
                        mel.slice(ndarray::s![frame..frame + EMBEDDING_WINDOW, ..]);
                    let window = window.as_standard_layout();
                    callback_embeddings.push(
                        reference_model
                            .emb_model
                            .detect(window.as_slice().unwrap())
                            .unwrap(),
                    );
                }
                if reference_embeddings.is_empty() {
                    for (index, embedding) in callback_embeddings.into_iter().enumerate() {
                        reference_embeddings.push_back((
                            next_reference_window_start
                                + index as u64 * STREAM_EMBEDDING_ADVANCE,
                            embedding,
                        ));
                    }
                } else {
                    reference_embeddings.push_back((
                        next_reference_window_start
                            + (num_windows - 1) as u64 * STREAM_EMBEDDING_ADVANCE,
                        callback_embeddings.pop().unwrap(),
                    ));
                    reference_embeddings.pop_front();
                }
                next_reference_window_start += STREAM_EMBEDDING_ADVANCE;
            }

            if since_predict < prediction_stride || state.embeddings.len() < MIN_EMBEDDINGS {
                continue;
            }
            since_predict = 0;

            for (index, ((actual_start, actual), (expected_start, expected))) in state
                .embeddings
                .iter()
                .zip(reference_embeddings.iter())
                .enumerate()
            {
                assert_eq!(actual_start, expected_start, "embedding {index} lattice key");
                for (&actual, &expected) in actual.iter().zip(expected.iter()) {
                    let diff = (actual - expected).abs();
                    max_embedding_diff = max_embedding_diff.max(diff);
                }
            }

            reference_state.embeddings = reference_embeddings.clone();
            reference_state.embeddings_since_predict = MIN_EMBEDDINGS;
            let expected_scores = reference_model
                .predict_stream(&mut reference_state)
                .unwrap();
            let legacy_scores = legacy_model
                .predict(&audio[position - STREAM_WINDOW_SAMPLES..position])
                .unwrap();
            let actual_scores = stream_model.predict_stream(&mut state).unwrap();
            for (name, expected) in expected_scores {
                let actual = actual_scores[&name];
                max_score_diff = max_score_diff.max((actual - expected).abs());
                max_legacy_score_diff =
                    max_legacy_score_diff.max((actual - legacy_scores[&name]).abs());
            }
            comparisons += 1;
        }

        eprintln!(
            "lattice parity: comparisons={comparisons} max_embedding_diff={max_embedding_diff:.3e} max_score_diff={max_score_diff:.3e} max_legacy_score_diff={max_legacy_score_diff:.3e}"
        );
        assert!(comparisons >= 20);
        assert!(
            max_embedding_diff <= 1e-6,
            "embedding max abs diff {max_embedding_diff} exceeded tolerance"
        );
        assert!(
            max_score_diff <= 1e-6,
            "score max abs diff {max_score_diff} exceeded tolerance"
        );
        assert!(
            max_legacy_score_diff <= 2e-5,
            "legacy score max abs diff {max_legacy_score_diff} exceeded tolerance"
        );
    }
}

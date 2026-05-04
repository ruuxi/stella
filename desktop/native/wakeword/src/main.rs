//! wakeword_listener — long-running native helper that watches the system mic
//! for a wake word and emits NDJSON events on stdout.
//!
//! Subcommands:
//!   probe --model <path.onnx>
//!     Loads the classifier and prints a single ready event with model names,
//!     then exits. Useful for smoke tests / Settings UI verification.
//!
//!   start --model <path.onnx> [--threshold 0.55] [--debounce-ms 1500]
//!         [--device <name>]
//!     Streams audio from the default input (or the named device) and emits
//!     {"event":"wake",...} every time the wake word fires above threshold,
//!     subject to debounce. Prints a single {"event":"ready",...} on startup
//!     once the model is loaded and the audio stream has begun.
//!
//! Stdout is the IPC channel: every line is a JSON object terminated by '\n'.
//! Stderr is for human-readable diagnostics and never used for IPC.

use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig};
use livekit_wakeword::wakeword::WakeWordModel;
use serde::Serialize;

/// Canonical sample rate expected by LiveKit's listener/model path.
/// Device audio is resampled to this rate before buffering so prediction
/// windows stay ~32k samples instead of ballooning on 48 kHz devices.
const MODEL_SAMPLE_RATE: u32 = 16_000;

/// Window of audio passed to predict() in seconds. Matches LiveKit's listener
/// behavior: keep a ~2s rolling chunk at 16 kHz and pass that to the stateless
/// model.
const PREDICT_WINDOW_SECS: f32 = 2.0;

/// How often we run inference. LiveKit's listener cadence is 80ms; 160ms keeps
/// us aligned to the embedding stride so cached overlapping windows remain exact.
const PREDICT_STRIDE_SECS: f32 = 0.16;

/// Very low energy gate: only skip obvious silence before running the model.
/// Speech in normal rooms is well above this; noisy rooms simply fall through
/// and preserve model behavior.
const ENERGY_GATE_WINDOW_SECS: f32 = 0.4;
const ENERGY_RMS_THRESHOLD: f32 = 0.002;
const ENERGY_PEAK_THRESHOLD: f32 = 0.015;

/// cpal callback chunk size hint, in samples. The OS may give us larger or
/// smaller chunks regardless; we just buffer.
const AUDIO_CHANNEL_CAPACITY: usize = 64;

#[derive(Parser, Debug)]
#[command(name = "wakeword_listener", about = "Stella wake-word listener.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Load a classifier and print its metadata, then exit.
    Probe {
        #[arg(long)]
        model: PathBuf,
    },
    /// Load a classifier and time repeated predict() calls on silence.
    Bench {
        #[arg(long)]
        model: PathBuf,
        #[arg(long, default_value_t = 25)]
        iterations: usize,
    },
    /// Stream audio from the input device and emit wake events.
    Start {
        #[arg(long)]
        model: PathBuf,
        #[arg(long, default_value_t = 0.55)]
        threshold: f32,
        #[arg(long = "debounce-ms", default_value_t = 1500)]
        debounce_ms: u64,
        /// Optional cpal device name. Defaults to the system default input.
        #[arg(long)]
        device: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Event<'a> {
    Ready {
        models: &'a [String],
        sample_rate: u32,
        channels: u16,
        device_name: &'a str,
    },
    Wake {
        model: &'a str,
        score: f32,
        threshold: f32,
        timestamp_ms: u128,
    },
    Error {
        message: &'a str,
    },
}

fn emit(event: &Event<'_>) {
    if let Ok(line) = serde_json::to_string(event) {
        println!("{}", line);
    }
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Probe { model } => run_probe(model),
        Command::Bench { model, iterations } => run_bench(model, iterations),
        Command::Start {
            model,
            threshold,
            debounce_ms,
            device,
        } => run_start(model, threshold, debounce_ms, device.as_deref()),
    };
    if let Err(err) = result {
        let msg = format!("{:#}", err);
        emit(&Event::Error { message: &msg });
        eprintln!("wakeword_listener: {}", msg);
        std::process::exit(1);
    }
}

fn load_model(model_path: &PathBuf) -> Result<WakeWordModel> {
    if !model_path.exists() {
        return Err(anyhow!("model not found: {}", model_path.display()));
    }
    WakeWordModel::new(&[model_path], MODEL_SAMPLE_RATE)
        .map_err(|e| anyhow!("failed to load wake word model: {}", e))
}

fn run_probe(model: PathBuf) -> Result<()> {
    // Use the canonical 16 kHz so probe doesn't depend on a usable input
    // device (some CI / headless boxes have no mic).
    let _model = load_model(&model)?;
    let stem = model
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();
    let models = [stem];
    emit(&Event::Ready {
        models: &models,
        sample_rate: MODEL_SAMPLE_RATE,
        channels: 1,
        device_name: "(probe — no device opened)",
    });
    Ok(())
}

fn run_bench(model: PathBuf, iterations: usize) -> Result<()> {
    let mut model_instance = load_model(&model)?;
    let audio = vec![0_i16; (MODEL_SAMPLE_RATE as f32 * PREDICT_WINDOW_SECS) as usize];
    let start = Instant::now();
    for _ in 0..iterations {
        let _ = model_instance.predict(&audio)?;
    }
    let elapsed = start.elapsed();
    let per_predict_ms = elapsed.as_secs_f64() * 1000.0 / iterations.max(1) as f64;
    eprintln!(
        "bench: iterations={} total_ms={:.1} per_predict_ms={:.1}",
        iterations,
        elapsed.as_secs_f64() * 1000.0,
        per_predict_ms,
    );
    Ok(())
}

fn pick_device(name: Option<&str>) -> Result<Device> {
    let host = cpal::default_host();
    if let Some(n) = name {
        for device in host.input_devices().context("enumerate input devices")? {
            if device.name().map(|d| d == n).unwrap_or(false) {
                return Ok(device);
            }
        }
        return Err(anyhow!("input device not found: {}", n));
    }
    host.default_input_device()
        .ok_or_else(|| anyhow!("no default input device"))
}

fn pick_input_config(device: &Device) -> Result<(StreamConfig, SampleFormat)> {
    // Preference order: 16 kHz mono i16 (no resampling, no conversion).
    // Falls back to the device's default input config; the WakeWordModel
    // will resample any rate in [22050, 384000] internally.
    let supported = device
        .supported_input_configs()
        .context("query supported input configs")?
        .collect::<Vec<_>>();

    for cfg in &supported {
        if cfg.channels() == 1
            && cfg.min_sample_rate().0 <= 16_000
            && cfg.max_sample_rate().0 >= 16_000
            && cfg.sample_format() == SampleFormat::I16
        {
            let stream_cfg = cfg
                .clone()
                .with_sample_rate(cpal::SampleRate(16_000))
                .config();
            return Ok((stream_cfg, SampleFormat::I16));
        }
    }
    for cfg in &supported {
        if cfg.channels() == 1
            && cfg.min_sample_rate().0 <= 16_000
            && cfg.max_sample_rate().0 >= 16_000
        {
            let format = cfg.sample_format();
            let stream_cfg = cfg
                .clone()
                .with_sample_rate(cpal::SampleRate(16_000))
                .config();
            return Ok((stream_cfg, format));
        }
    }

    let default = device
        .default_input_config()
        .context("default input config")?;
    Ok((default.config(), default.sample_format()))
}

fn run_start(
    model_path: PathBuf,
    threshold: f32,
    debounce_ms: u64,
    device_name: Option<&str>,
) -> Result<()> {
    let device = pick_device(device_name)?;
    let device_label = device.name().unwrap_or_else(|_| "<unknown>".to_string());
    let (config, sample_format) = pick_input_config(&device)?;
    let channels = config.channels;
    let sample_rate = config.sample_rate.0;

    let mut model = load_model(&model_path)?;
    let model_name = model_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("model")
        .to_string();

    let (tx, rx) = sync_channel::<Vec<i16>>(AUDIO_CHANNEL_CAPACITY);

    // Build the input stream in a sample-format-aware way. cpal hands us
    // raw frames, we downmix to mono i16 here so the inference loop only
    // ever sees i16 mono.
    let stream = build_input_stream(&device, &config, sample_format, channels, tx)?;
    stream.play().context("start cpal stream")?;

    let models = [model_name.clone()];
    emit(&Event::Ready {
        models: &models,
        sample_rate,
        channels,
        device_name: &device_label,
    });

    run_inference_loop(
        &mut model,
        &model_name,
        threshold,
        debounce_ms,
        sample_rate,
        rx,
    )?;

    // Keep `stream` alive until the inference loop exits (it owns the cpal
    // input callback). Drop here so the hardware is released cleanly.
    drop(stream);
    Ok(())
}

fn build_input_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    channels: u16,
    tx: std::sync::mpsc::SyncSender<Vec<i16>>,
) -> Result<cpal::Stream> {
    let err_fn = |err| eprintln!("wakeword_listener: stream error: {}", err);
    let stream = match sample_format {
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| {
                let frames = downmix_i16(data, channels);
                let _ = tx.try_send(frames);
            },
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _| {
                let frames: Vec<i16> = data.iter().map(|&s| (s as i32 - 32_768) as i16).collect();
                let mono = downmix_i16(&frames, channels);
                let _ = tx.try_send(mono);
            },
            err_fn,
            None,
        ),
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| {
                let frames: Vec<i16> = data
                    .iter()
                    .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                    .collect();
                let mono = downmix_i16(&frames, channels);
                let _ = tx.try_send(mono);
            },
            err_fn,
            None,
        ),
        other => {
            return Err(anyhow!("unsupported sample format: {:?}", other));
        }
    }
    .context("build cpal input stream")?;
    Ok(stream)
}

fn downmix_i16(samples: &[i16], channels: u16) -> Vec<i16> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let n = channels as usize;
    samples
        .chunks_exact(n)
        .map(|frame| {
            let sum: i32 = frame.iter().map(|&s| s as i32).sum();
            (sum / n as i32) as i16
        })
        .collect()
}

fn run_inference_loop(
    model: &mut WakeWordModel,
    model_name: &str,
    threshold: f32,
    debounce_ms: u64,
    sample_rate: u32,
    rx: Receiver<Vec<i16>>,
) -> Result<()> {
    let window_samples = (MODEL_SAMPLE_RATE as f32 * PREDICT_WINDOW_SECS).round() as usize;
    let stride_samples = (MODEL_SAMPLE_RATE as f32 * PREDICT_STRIDE_SECS).round() as usize;
    let mut ring: Vec<i16> = Vec::with_capacity(window_samples * 2);
    let mut samples_since_predict: usize = 0;
    let mut last_fire = Instant::now() - Duration::from_secs(60);
    let debounce = Duration::from_millis(debounce_ms);
    let mut resampler = LinearResampler::new(sample_rate, MODEL_SAMPLE_RATE);

    while let Ok(chunk) = rx.recv() {
        let chunk = resampler.process(&chunk);
        if chunk.is_empty() {
            continue;
        }
        ring.extend_from_slice(&chunk);
        samples_since_predict += chunk.len();

        // Cap ring at one window — older audio can't influence the next
        // prediction (the model only consumes the last 16 embedding
        // timesteps anyway) and unbounded growth would leak.
        if ring.len() > window_samples {
            let drop = ring.len() - window_samples;
            ring.drain(..drop);
        }

        if samples_since_predict < stride_samples || ring.len() < window_samples {
            continue;
        }
        samples_since_predict = 0;

        if !has_recent_energy(&ring, MODEL_SAMPLE_RATE) {
            continue;
        }

        let scores = match model.predict(&ring) {
            Ok(s) => s,
            Err(e) => {
                let msg = format!("predict failed: {}", e);
                emit(&Event::Error { message: &msg });
                continue;
            }
        };

        let score = scores
            .get(model_name)
            .copied()
            .unwrap_or_else(|| scores.values().copied().fold(f32::NEG_INFINITY, f32::max));
        if score >= threshold && last_fire.elapsed() >= debounce {
            last_fire = Instant::now();
            let timestamp_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            emit(&Event::Wake {
                model: model_name,
                score,
                threshold,
                timestamp_ms,
            });
            // Match LiveKit's listener behavior: after a detection, discard the
            // current window so stale wake-word audio cannot influence the next
            // decision. The CLI has no wait_for_detection() consumer to pause
            // on, so it immediately starts filling a fresh window.
            ring.clear();
            samples_since_predict = 0;
        }
    }
    Ok(())
}

fn has_recent_energy(samples: &[i16], sample_rate: u32) -> bool {
    let window = (sample_rate as f32 * ENERGY_GATE_WINDOW_SECS).round() as usize;
    let start = samples.len().saturating_sub(window.max(1));
    let recent = &samples[start..];
    if recent.is_empty() {
        return false;
    }

    let mut sum_squares = 0.0f64;
    let mut peak = 0.0f32;
    for &sample in recent {
        let normalized = sample as f32 / i16::MAX as f32;
        sum_squares += (normalized as f64) * (normalized as f64);
        peak = peak.max(normalized.abs());
    }
    let rms = (sum_squares / recent.len() as f64).sqrt() as f32;
    rms >= ENERGY_RMS_THRESHOLD || peak >= ENERGY_PEAK_THRESHOLD
}

struct LinearResampler {
    source_rate: u32,
    target_rate: u32,
    step: f64,
    cursor: f64,
    previous_sample: Option<i16>,
}

impl LinearResampler {
    fn new(source_rate: u32, target_rate: u32) -> Self {
        Self {
            source_rate,
            target_rate,
            step: source_rate as f64 / target_rate as f64,
            cursor: 0.0,
            previous_sample: None,
        }
    }

    fn process(&mut self, samples: &[i16]) -> Vec<i16> {
        if samples.is_empty() {
            return Vec::new();
        }
        if self.source_rate == self.target_rate {
            return samples.to_vec();
        }

        let mut input = Vec::with_capacity(samples.len() + 1);
        if let Some(previous) = self.previous_sample {
            input.push(previous);
        }
        input.extend_from_slice(samples);

        let mut out = Vec::with_capacity(
            ((samples.len() as f64) * (self.target_rate as f64 / self.source_rate as f64)).ceil()
                as usize
                + 1,
        );
        while self.cursor + 1.0 < input.len() as f64 {
            let i = self.cursor.floor() as usize;
            let frac = self.cursor - i as f64;
            let a = input[i] as f64;
            let b = input[i + 1] as f64;
            out.push(
                (a + (b - a) * frac)
                    .round()
                    .clamp(i16::MIN as f64, i16::MAX as f64) as i16,
            );
            self.cursor += self.step;
        }

        // Keep the final source sample so interpolation across callback
        // boundaries is continuous.
        self.previous_sample = input.last().copied();
        self.cursor -= (input.len().saturating_sub(1)) as f64;
        out
    }
}

export type MusicMood = "Focus" | "Calm" | "Energy" | "Sleep" | "Lo-fi"

export type PromptSet = {
  label: string
  prompts: { text: string; weight: number }[]
  config: {
    bpm: number
    density: number
    brightness: number
    guidance: number
    temperature: number
  }
}

const FOCUS_PROMPTS: PromptSet[] = [
  {
    label: "Deep focus",
    prompts: [
      {
        text: "Minimal ambient electronica with soft evolving pads, gentle plucked synths, and subtle rhythmic pulse",
        weight: 1.0,
      },
    ],
    config: { bpm: 110, density: 0.4, brightness: 0.45, guidance: 4.0, temperature: 1.0 },
  },
  {
    label: "Concentration",
    prompts: [
      {
        text: "Downtempo electronic with warm analog synths, light arpeggios, and a steady understated beat",
        weight: 0.8,
      },
      { text: "Ambient textures with distant reverb tails and soft white noise", weight: 0.3 },
    ],
    config: { bpm: 100, density: 0.35, brightness: 0.4, guidance: 3.5, temperature: 1.1 },
  },
  {
    label: "Flow state",
    prompts: [
      {
        text: "Soft ambient techno with warm pads, muted kick drum, delicate melodic fragments, and shimmering textures",
        weight: 1.0,
      },
    ],
    config: { bpm: 105, density: 0.45, brightness: 0.5, guidance: 4.0, temperature: 1.0 },
  },
  {
    label: "Quiet clarity",
    prompts: [
      {
        text: "Sparse ambient piano with gentle granular synthesis textures, soft sub bass, and minimal percussion",
        weight: 1.0,
      },
    ],
    config: { bpm: 95, density: 0.3, brightness: 0.35, guidance: 3.5, temperature: 1.0 },
  },
  {
    label: "Steady mind",
    prompts: [
      {
        text: "Minimal electronic with pulsing synth bass, soft rhodes chords, and a hypnotic repetitive groove",
        weight: 0.9,
      },
      { text: "Subtle glitch textures and filtered atmospheres", weight: 0.2 },
    ],
    config: { bpm: 108, density: 0.42, brightness: 0.48, guidance: 4.0, temperature: 1.1 },
  },
]

const CALM_PROMPTS: PromptSet[] = [
  {
    label: "Peaceful",
    prompts: [
      {
        text: "Soft ambient piano with gentle reverb, slow evolving strings, and nature-inspired textures",
        weight: 1.0,
      },
    ],
    config: { bpm: 70, density: 0.25, brightness: 0.35, guidance: 4.0, temperature: 1.0 },
  },
  {
    label: "Serene",
    prompts: [
      {
        text: "Gentle acoustic guitar fingerpicking with airy pads, soft flute, and warm ambient washes",
        weight: 1.0,
      },
    ],
    config: { bpm: 75, density: 0.3, brightness: 0.4, guidance: 3.5, temperature: 1.0 },
  },
  {
    label: "Stillness",
    prompts: [
      {
        text: "Very slow ambient drones with glass-like tones, distant chimes, and barely audible field recordings",
        weight: 1.0,
      },
    ],
    config: { bpm: 65, density: 0.15, brightness: 0.3, guidance: 3.0, temperature: 0.9 },
  },
  {
    label: "Gentle waves",
    prompts: [
      {
        text: "Soothing ambient with slow-moving synth pads, soft harp arpeggios, and warm cello undertones",
        weight: 0.9,
      },
      { text: "Ocean-like white noise textures and gentle swells", weight: 0.2 },
    ],
    config: { bpm: 68, density: 0.2, brightness: 0.32, guidance: 3.5, temperature: 1.0 },
  },
]

const ENERGY_PROMPTS: PromptSet[] = [
  {
    label: "Upbeat",
    prompts: [
      {
        text: "Upbeat electronic pop with bright synth leads, driving bass, and energetic drums",
        weight: 1.0,
      },
    ],
    config: { bpm: 128, density: 0.75, brightness: 0.7, guidance: 4.5, temperature: 1.2 },
  },
  {
    label: "Power drive",
    prompts: [
      {
        text: "High energy EDM with pumping sidechain bass, soaring synth melodies, and hard-hitting four-on-the-floor drums",
        weight: 1.0,
      },
    ],
    config: { bpm: 130, density: 0.8, brightness: 0.75, guidance: 4.5, temperature: 1.2 },
  },
  {
    label: "Electric groove",
    prompts: [
      {
        text: "Funky electronic with groovy bass synth, punchy drums, bright stabs, and rhythmic energy",
        weight: 0.9,
      },
      { text: "Disco-influenced synthesizer riffs and funky guitar licks", weight: 0.3 },
    ],
    config: { bpm: 122, density: 0.7, brightness: 0.65, guidance: 4.0, temperature: 1.1 },
  },
  {
    label: "Rush",
    prompts: [
      {
        text: "Fast-paced drum and bass with rolling breakbeats, heavy sub bass, and sharp synth stabs",
        weight: 1.0,
      },
    ],
    config: { bpm: 140, density: 0.85, brightness: 0.6, guidance: 4.5, temperature: 1.3 },
  },
  {
    label: "Momentum",
    prompts: [
      {
        text: "Driving techno with relentless kick drum, acid bassline, layered percussion, and hypnotic synth loops",
        weight: 1.0,
      },
    ],
    config: { bpm: 135, density: 0.78, brightness: 0.55, guidance: 4.0, temperature: 1.2 },
  },
]

const SLEEP_PROMPTS: PromptSet[] = [
  {
    label: "Dreamscape",
    prompts: [
      {
        text: "Ultra-soft ambient drone with slow-moving harmonic washes, barely audible chimes, and deep sub bass",
        weight: 1.0,
      },
    ],
    config: { bpm: 60, density: 0.15, brightness: 0.2, guidance: 3.0, temperature: 0.8 },
  },
  {
    label: "Night sky",
    prompts: [
      {
        text: "Ethereal ambient with celestial pads, very gentle tonal shifts, and deep warm bass tones",
        weight: 1.0,
      },
    ],
    config: { bpm: 60, density: 0.1, brightness: 0.18, guidance: 2.5, temperature: 0.7 },
  },
  {
    label: "Deep rest",
    prompts: [
      {
        text: "Minimal drone ambient with extremely slow harmonic movement, soft pink noise, and resonant low tones",
        weight: 1.0,
      },
    ],
    config: { bpm: 60, density: 0.08, brightness: 0.15, guidance: 2.0, temperature: 0.6 },
  },
  {
    label: "Lullaby",
    prompts: [
      {
        text: "Very soft music box melody with warm ambient pads, gentle reverb, and soothing low-frequency hum",
        weight: 0.7,
      },
      { text: "Whispered atmospheric textures and distant soft bells", weight: 0.2 },
    ],
    config: { bpm: 60, density: 0.12, brightness: 0.22, guidance: 3.0, temperature: 0.8 },
  },
]

const LOFI_PROMPTS: PromptSet[] = [
  {
    label: "Lo-fi chill",
    prompts: [
      {
        text: "Lo-fi hip hop with warm vinyl crackle, mellow jazz piano chords, tape-saturated drums, and smooth bass",
        weight: 1.0,
      },
    ],
    config: { bpm: 85, density: 0.5, brightness: 0.4, guidance: 4.0, temperature: 1.1 },
  },
  {
    label: "Lazy afternoon",
    prompts: [
      {
        text: "Chilled lo-fi beat with soft electric piano, warm bass guitar, dusty drum loop, and ambient room tone",
        weight: 1.0,
      },
    ],
    config: { bpm: 80, density: 0.45, brightness: 0.38, guidance: 3.5, temperature: 1.0 },
  },
  {
    label: "Rainy day",
    prompts: [
      {
        text: "Melancholic lo-fi with detuned piano, slow brushed drums, warm tape-saturated bass, and rain-like textures",
        weight: 0.9,
      },
      { text: "Soft ambient pad with vinyl hiss and subtle stereo movement", weight: 0.2 },
    ],
    config: { bpm: 78, density: 0.42, brightness: 0.35, guidance: 4.0, temperature: 1.0 },
  },
  {
    label: "Coffee shop",
    prompts: [
      {
        text: "Warm lo-fi jazz with rhodes piano, soft upright bass, gentle brush drums, and cozy analog warmth",
        weight: 1.0,
      },
    ],
    config: { bpm: 82, density: 0.48, brightness: 0.42, guidance: 3.5, temperature: 1.1 },
  },
  {
    label: "Late night",
    prompts: [
      {
        text: "Dark lo-fi beat with moody minor key piano, deep sub bass, slow shuffling drums, and spacious reverb",
        weight: 1.0,
      },
    ],
    config: { bpm: 75, density: 0.4, brightness: 0.3, guidance: 4.0, temperature: 1.0 },
  },
]

const MOOD_PROMPTS: Record<MusicMood, PromptSet[]> = {
  Focus: FOCUS_PROMPTS,
  Calm: CALM_PROMPTS,
  Energy: ENERGY_PROMPTS,
  Sleep: SLEEP_PROMPTS,
  "Lo-fi": LOFI_PROMPTS,
}

export function getPromptsForMood(mood: MusicMood, cycleIndex: number = 0): PromptSet {
  const prompts = MOOD_PROMPTS[mood]
  return prompts[cycleIndex % prompts.length]
}

import { createServiceRequest } from "@/services/http/service-request"

export type MusicMood = "Auto" | "Focus" | "Calm" | "Energy" | "Sleep" | "Lo-fi"

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

// ---------------------------------------------------------------------------
// Mood context for the LLM
// ---------------------------------------------------------------------------

const MOOD_GUIDANCE: Record<MusicMood, string> = {
  Auto:
    "You have full creative freedom. Choose any genre, instruments, tempo, and mood that you think would sound great. If the user provided instructions, use those as your primary guide. Otherwise, surprise with something interesting and varied.",
  Focus:
    "Music for concentration and productivity. Steady rhythm, moderate tempo (90-115 BPM). Think ambient electronica, soft arpeggios, subtle pulse.",
  Calm:
    "Peaceful, relaxing music. Slow tempo (60-80 BPM), low density, gentle instruments like piano, strings, soft pads. Nature-inspired textures.",
  Energy:
    "High energy, upbeat music. Fast tempo (120-145 BPM), high density, bright tones. Electronic, driving bass, energetic drums.",
  Sleep:
    "Ultra-soft ambient for sleeping. Very slow (55-65 BPM), extremely low density and brightness. Drones, soft washes, barely audible textures. No percussion.",
  "Lo-fi":
    "Lo-fi hip hop and chill beats. Moderate-slow tempo (72-90 BPM), medium density. Vinyl crackle, jazz chords, tape-saturated drums, warm analog sound.",
}

const SYSTEM_PROMPT = `You are a music director for Lyria, Google's AI music generator. You write rich, descriptive prompts that paint a vivid sonic picture.

## How to Write Great Lyria Prompts

Lyria responds best to detailed, descriptive prose — not just comma-separated keywords. Describe the genre, style, mood, instrumentation, tempo, rhythm, arrangement, and production quality in natural language. The more specific and evocative, the better.

### Prompt Structure

Include as many of these elements as relevant:
- **Genre & Style**: Primary genre, era, stylistic influences. Blend genres for unique results: "catchy K-pop tune with a Motown edge", "classical violins into a funk track"
- **Mood & Emotion**: The feeling the music evokes
- **Instrumentation**: Specific instruments and their roles (lead, rhythm, texture)
- **Tempo & Rhythm**: Pace, rhythmic character, groove description
- **Arrangement**: How instruments interact, layers, dynamics, progression
- **Production Quality**: Recording style, sonic character (warm, crispy, lo-fi, polished)
- **Vocal qualities** (when lyrics enabled): Describe vocal style — "commanding baritone", "breathy female soprano", "gritty soulful tenor"

### Reference Examples (from Google's Lyria docs)

GOOD — Rich and descriptive:
"Quintessential 1970s Motown soul. Lush, orchestral R&B production. Warm bassline with melodic fills, locked into a steady drum groove with crisp snare and tambourine. Vintage organ harmonic bed. Three-piece brass section. Gritty, gospel-tinged male tenor lead."

"Wistful and airy. Soft, breathy female vocals with intimacy. Rapid-fire drum and bass rhythm, low-passed and softened. Deep, warm bass swells. Dreamy electric piano chords and subtle chime textures. Rainy city vibes."

"Nocturnal aesthetic with cinematic forward motion. Driving 16th-note analog synthesizer bass arpeggio. Percussion anchored by powerful snare with 1980s gated reverb. Swelling cinematic pads. Male vocalist with soaring vocal lines."

"An intimate, sophisticated Brazilian Bossa Nova track evoking the quiet atmosphere of a Rio beach at sunset. Gentle fingerpicked nylon guitar over a soft, brushed drum groove. Warm upright bass. Rhodes piano adding color."

"A calm and dreamy ambient soundscape featuring layered synthesizers and soft, evolving pads. Slow tempo with a spacious reverb. Starts with a simple synth melody, then adds layers of atmospheric pads."

"A tense, suspenseful underscore with a very slow, creeping tempo and a sparse, irregular rhythm. Primarily uses low strings and subtle percussion."

BAD — Too vague:
"relaxing piano music"
"a rock song"
"upbeat electronic"

### Known Lyria Vocabulary

You may freely use natural language descriptions, but Lyria has special recognition for these terms:

INSTRUMENTS: 303 Acid Bass, 808 Hip Hop Beat, Accordion, Alto Saxophone, Bagpipes, Balalaika Ensemble, Banjo, Bass Clarinet, Bongos, Boomy Bass, Bouzouki, Buchla Synths, Cello, Charango, Clavichord, Conga Drums, Didgeridoo, Dirty Synths, Djembe, Drumline, Dulcimer, Fiddle, Flamenco Guitar, Funk Drums, Glockenspiel, Guitar, Hang Drum, Harmonica, Harp, Harpsichord, Hurdy-gurdy, Kalimba, Koto, Lyre, Mandolin, Maracas, Marimba, Mbira, Mellotron, Metallic Twang, Moog Oscillations, Ocarina, Persian Tar, Pipa, Precision Bass, Ragtime Piano, Rhodes Piano, Shamisen, Shredding Guitar, Sitar, Slide Guitar, Smooth Pianos, Spacey Synths, Steel Drum, Synth Pads, Tabla, TR-909 Drum Machine, Trumpet, Tuba, Vibraphone, Viola Ensemble, Warm Acoustic Guitar, Woodwinds

GENRES: Acid Jazz, Afrobeat, Alternative Country, Baroque, Bengal Baul, Bhangra, Bluegrass, Blues Rock, Bossa Nova, Breakbeat, Celtic Folk, Chillout, Chiptune, Classic Rock, Contemporary R&B, Cumbia, Deep House, Disco Funk, Drum & Bass, Dubstep, EDM, Electro Swing, Funk Metal, G-funk, Garage Rock, Glitch Hop, Grime, Hyperpop, Indian Classical, Indie Electronic, Indie Folk, Indie Pop, Irish Folk, Jam Band, Jamaican Dub, Jazz Fusion, Latin Jazz, Lo-Fi Hip Hop, Marching Band, Merengue, New Jack Swing, Minimal Techno, Moombahton, Neo-Soul, Orchestral Score, Piano Ballad, Polka, Post-Punk, 60s Psychedelic Rock, Psytrance, R&B, Reggae, Reggaeton, Renaissance Music, Salsa, Shoegaze, Ska, Surf Rock, Synthpop, Techno, Trance, Trap Beat, Trip Hop, Vaporwave, Witch House

MOODS: Acoustic Instruments, Ambient, Bright Tones, Chill, Crunchy Distortion, Danceable, Dreamy, Echo, Emotional, Ethereal Ambience, Experimental, Fat Beats, Funky, Glitchy Effects, Huge Drop, Live Performance, Lo-fi, Ominous Drone, Psychedelic, Rich Orchestration, Saturated Tones, Subdued Melody, Sustained Chords, Swirling Phasers, Tight Groove, Unsettling, Upbeat, Virtuoso, Weird Noises

## Lyrics

When lyrics are enabled, Lyria generates vocal content. Add a "Lyrics:" section at the end of the prompt text with creative lyrics. You can add backing vocals in parentheses.
Example: "Indie Pop, Dreamy, Emotional. Smooth Pianos with a gentle beat. Breathy female vocals with intimacy. Lyrics: Walking through the city lights _(lights)_, finding my way home tonight"
When lyrics are disabled, do NOT include any Lyrics: section or vocal descriptions.

## Multi-Prompt Layering

You can use 1-3 prompts with different weights to layer sonic elements:
- Primary prompt (weight 1.0): The main genre, mood, and instrumentation
- Accent layers (weight 0.2-0.5): Additional texture, atmosphere, or stylistic flavor

## Output Format

You output ONLY valid JSON — no markdown, no explanation, no thinking. The JSON schema:
{
  "label": "A short 2-3 word name (e.g. 'Midnight rain', 'Solar drift')",
  "prompts": [
    { "text": "Your rich, descriptive prompt text here", "weight": 1.0 }
  ],
  "config": {
    "bpm": <number 55-145>,
    "density": <number 0.05-0.9>,
    "brightness": <number 0.1-0.8>,
    "guidance": <number 2.0-5.0>,
    "temperature": <number 0.6-1.4>
  }
}

Rules:
- Write prompts as rich, descriptive prose — NOT just comma-separated keywords
- Weave in Lyria vocabulary terms naturally within your descriptions
- The label should be creative and poetic, never generic
- Config values must stay within the ranges shown
- Each generation should feel distinct from the previous one while staying within the mood
- If user instructions are provided, incorporate them as the primary creative direction — translate casual requests (e.g. "kpop superhit") into detailed Lyria prompts
- NEVER include real artist names, song titles, or copyrighted material in prompts or lyrics`

// ---------------------------------------------------------------------------
// LLM prompt generation
// ---------------------------------------------------------------------------

export async function generateMusicPrompt(
  mood: MusicMood,
  previousLabel: string | null,
  userHint: string | null,
  lyrics: boolean,
): Promise<PromptSet> {
  const moodContext = MOOD_GUIDANCE[mood]

  let userMessage = `Mood: ${mood}\nMood guidance: ${moodContext}`
  userMessage += `\nLyrics: ${lyrics ? "ENABLED — include a Lyrics: section with creative vocal content in the prompt" : "DISABLED — instrumental only, no vocals or lyrics"}`

  if (previousLabel) {
    userMessage += `\n\nThe previous sound was called "${previousLabel}". Create something that feels like a natural evolution — different but cohesive.`
  } else {
    userMessage += `\n\nThis is the first generation. Create an inviting opening sound for this mood.`
  }

  if (userHint?.trim()) {
    userMessage += `\n\nUser's additional direction: "${userHint.trim()}"`
  }

  try {
    const { endpoint, headers } = await createServiceRequest("/api/ai/proxy", {
      "Content-Type": "application/json",
    })

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: userMessage }],
        system: SYSTEM_PROMPT,
        agentType: "music_prompt",
        stream: false,
      }),
    })

    if (!res.ok) {
      return getFallbackPrompt(mood)
    }

    const json = (await res.json()) as { text?: string }
    if (!json.text) {
      return getFallbackPrompt(mood)
    }

    // Parse JSON from LLM response (strip any markdown fences)
    const cleaned = json.text.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleaned) as PromptSet

    // Validate structure
    if (
      !parsed.label ||
      !Array.isArray(parsed.prompts) ||
      parsed.prompts.length === 0 ||
      !parsed.config
    ) {
      return getFallbackPrompt(mood)
    }

    // Clamp config values to valid ranges
    parsed.config.bpm = clamp(parsed.config.bpm, 55, 145)
    parsed.config.density = clamp(parsed.config.density, 0.05, 0.9)
    parsed.config.brightness = clamp(parsed.config.brightness, 0.1, 0.8)
    parsed.config.guidance = clamp(parsed.config.guidance, 2.0, 5.0)
    parsed.config.temperature = clamp(parsed.config.temperature, 0.6, 1.4)

    return parsed
  } catch (err) {
    return getFallbackPrompt(mood)
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

// ---------------------------------------------------------------------------
// Fallback prompts (used when LLM is unavailable)
// ---------------------------------------------------------------------------

const FALLBACKS: Record<MusicMood, PromptSet> = {
  Auto: {
    label: "Golden hour",
    prompts: [
      { text: "A smooth Jazz Fusion piece with a laid-back groove. Rhodes Piano provides warm chords over a Precision Bass walking line. Alto Saxophone plays a dreamy, improvised melody. Relaxed brushed drums with a tight groove. Late-night cafe atmosphere.", weight: 1.0 },
    ],
    config: { bpm: 95, density: 0.5, brightness: 0.5, guidance: 4.0, temperature: 1.1 },
  },
  Focus: {
    label: "Deep focus",
    prompts: [
      { text: "A calm and focused Indie Electronic ambient piece. Layered Synth Pads with slow, evolving textures and sustained chords. Rhodes Piano plays a subdued, repeating melody. Minimal percussion — just a soft pulse keeping steady time. Spacious reverb, clean production.", weight: 1.0 },
    ],
    config: { bpm: 105, density: 0.4, brightness: 0.45, guidance: 4.0, temperature: 1.0 },
  },
  Calm: {
    label: "Still water",
    prompts: [
      { text: "A peaceful and serene ambient soundscape. Smooth Pianos play gentle, floating arpeggios. Harp adds delicate ornamental touches. Soft, evolving Synth Pads create an ethereal ambience. Very slow tempo with spacious reverb. Dreamy, nature-inspired textures.", weight: 1.0 },
    ],
    config: { bpm: 70, density: 0.25, brightness: 0.35, guidance: 4.0, temperature: 1.0 },
  },
  Energy: {
    label: "Neon rush",
    prompts: [
      { text: "An energetic EDM track with a driving beat and massive energy. TR-909 Drum Machine provides a four-on-the-floor kick with crispy hi-hats. Dirty Synths build tension with rising filter sweeps. Fat Beats and a boomy bass drop. Bright, danceable, festival-ready production with high-quality mastering.", weight: 1.0 },
    ],
    config: { bpm: 128, density: 0.75, brightness: 0.7, guidance: 4.5, temperature: 1.2 },
  },
  Sleep: {
    label: "Dreamscape",
    prompts: [
      { text: "An ultra-soft ambient soundscape for deep sleep. Barely audible Synth Pads drift in and out like slow breathing. Kalimba plays sparse, gentle notes with long decay. No percussion at all. Extremely slow, spacious, with warm low-frequency drones. Like floating through clouds in the dark.", weight: 1.0 },
    ],
    config: { bpm: 60, density: 0.15, brightness: 0.2, guidance: 3.0, temperature: 0.8 },
  },
  "Lo-fi": {
    label: "Rainy tape",
    prompts: [
      { text: "A nostalgic Lo-Fi Hip Hop beat with warm, tape-saturated production. Rhodes Piano plays jazzy chords with subtle pitch wobble. Warm Acoustic Guitar adds fingerpicked texture. Soft, lo-fi drums with vinyl crackle and room tone. Chill, intimate, late-night study vibes. Tight groove with a head-nodding swing.", weight: 1.0 },
    ],
    config: { bpm: 85, density: 0.5, brightness: 0.4, guidance: 4.0, temperature: 1.1 },
  },
}

export function getFallbackPrompt(mood: MusicMood): PromptSet {
  return { ...FALLBACKS[mood] }
}

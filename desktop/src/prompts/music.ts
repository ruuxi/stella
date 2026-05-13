type RuntimeAgentApi = {
  oneShotCompletion: (payload: {
    agentType: string
    systemPrompt?: string
    userText: string
    maxOutputTokens?: number
    temperature?: number
    fallbackAgentTypes?: string[]
  }) => Promise<{ text: string }>
}

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

const MUSIC_SYSTEM_PROMPT = `You are a music director for Lyria, Google's AI music generator. You write rich, descriptive prompts that paint a vivid sonic picture.

Write detailed natural-language prompts describing genre, mood, instrumentation, tempo, arrangement, production quality, and vocals only when lyrics are enabled. Use vivid, specific sonic language instead of comma-separated keywords.

Output ONLY valid JSON with this schema:
{
  "label": "A short 2-3 word name",
  "prompts": [
    { "text": "A rich, descriptive Lyria prompt", "weight": 1.0 }
  ],
  "config": {
    "bpm": 95,
    "density": 0.5,
    "brightness": 0.5,
    "guidance": 4,
    "temperature": 1
  }
}

Rules:
- Config values must stay within the requested ranges.
- Each generation should feel distinct from the previous one while staying within the mood.
- If user instructions are provided, use them as the primary creative direction.
- Do not include real artist names, song titles, or copyrighted material.`

export const getMusicSystemPrompt = (): string => MUSIC_SYSTEM_PROMPT

export async function generateMusicPrompt(
  mood: MusicMood,
  previousLabel: string | null,
  userHint: string | null,
  lyrics: boolean,
): Promise<PromptSet> {
  const moodContext = MOOD_GUIDANCE[mood]

  let userMessage = `Mood: ${mood}\nMood guidance: ${moodContext}`
  userMessage += `\nLyrics: ${lyrics ? "ENABLED - include a Lyrics: section with creative vocal content in the prompt" : "DISABLED - instrumental only, no vocals or lyrics"}`

  if (previousLabel) {
    userMessage += `\n\nThe previous sound was called "${previousLabel}". Create something that feels like a natural evolution - different but cohesive.`
  } else {
    userMessage += `\n\nThis is the first generation. Create an inviting opening sound for this mood.`
  }

  if (userHint?.trim()) {
    userMessage += `\n\nUser's additional direction: "${userHint.trim()}"`
  }

  const agentApi = (window as unknown as { electronAPI?: { agent?: RuntimeAgentApi } })
    .electronAPI?.agent
  if (!agentApi?.oneShotCompletion) {
    return getFallbackPrompt(mood)
  }

  try {
    const result = await agentApi.oneShotCompletion({
      agentType: "music_prompt",
      systemPrompt: getMusicSystemPrompt(),
      userText: userMessage,
      // Ride the user's Assistant-tab BYOK pick when the user has chosen a
      // non-Stella provider, instead of pinning to Stella's managed gateway.
      fallbackAgentTypes: ["general"],
      temperature: 1,
      maxOutputTokens: 16192,
    })
    const responseText = result?.text ?? ""
    if (!responseText) {
      return getFallbackPrompt(mood)
    }

    const cleaned = responseText.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim()
    const parsed = JSON.parse(cleaned) as PromptSet

    if (
      !parsed.label ||
      !Array.isArray(parsed.prompts) ||
      parsed.prompts.length === 0 ||
      !parsed.config
    ) {
      return getFallbackPrompt(mood)
    }

    parsed.config.bpm = clamp(parsed.config.bpm, 55, 145)
    parsed.config.density = clamp(parsed.config.density, 0.05, 0.9)
    parsed.config.brightness = clamp(parsed.config.brightness, 0.1, 0.8)
    parsed.config.guidance = clamp(parsed.config.guidance, 2.0, 5.0)
    parsed.config.temperature = clamp(parsed.config.temperature, 0.6, 1.4)

    return parsed
  } catch {
    return getFallbackPrompt(mood)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const FALLBACKS: Record<MusicMood, PromptSet> = {
  Auto: {
    label: "Golden hour",
    prompts: [
      {
        text: "A smooth Jazz Fusion piece with a laid-back groove. Rhodes Piano provides warm chords over a Precision Bass walking line. Alto Saxophone plays a dreamy, improvised melody. Relaxed brushed drums with a tight groove. Late-night cafe atmosphere.",
        weight: 1,
      },
    ],
    config: { bpm: 95, density: 0.5, brightness: 0.5, guidance: 4, temperature: 1.1 },
  },
  Focus: {
    label: "Deep focus",
    prompts: [
      {
        text: "A calm and focused Indie Electronic ambient piece. Layered Synth Pads with slow, evolving textures and sustained chords. Rhodes Piano plays a subdued, repeating melody. Minimal percussion - just a soft pulse keeping steady time. Spacious reverb, clean production.",
        weight: 1,
      },
    ],
    config: { bpm: 105, density: 0.4, brightness: 0.45, guidance: 4, temperature: 1 },
  },
  Calm: {
    label: "Still water",
    prompts: [
      {
        text: "A peaceful and serene ambient soundscape. Smooth Pianos play gentle, floating arpeggios. Harp adds delicate ornamental touches. Soft, evolving Synth Pads create an ethereal ambience. Very slow tempo with spacious reverb. Dreamy, nature-inspired textures.",
        weight: 1,
      },
    ],
    config: { bpm: 70, density: 0.25, brightness: 0.35, guidance: 4, temperature: 1 },
  },
  Energy: {
    label: "Neon rush",
    prompts: [
      {
        text: "An energetic EDM track with a driving beat and massive energy. TR-909 Drum Machine provides a four-on-the-floor kick with crispy hi-hats. Dirty Synths build tension with rising filter sweeps. Fat Beats and a boomy bass drop. Bright, danceable, festival-ready production with high-quality mastering.",
        weight: 1,
      },
    ],
    config: { bpm: 128, density: 0.75, brightness: 0.7, guidance: 4.5, temperature: 1.2 },
  },
  Sleep: {
    label: "Dreamscape",
    prompts: [
      {
        text: "An ultra-soft ambient soundscape for deep sleep. Barely audible Synth Pads drift in and out like slow breathing. Kalimba plays sparse, gentle notes with long decay. No percussion at all. Extremely slow, spacious, with warm low-frequency drones. Like floating through clouds in the dark.",
        weight: 1,
      },
    ],
    config: { bpm: 60, density: 0.15, brightness: 0.2, guidance: 3, temperature: 0.8 },
  },
  "Lo-fi": {
    label: "Rainy tape",
    prompts: [
      {
        text: "A nostalgic Lo-Fi Hip Hop beat with warm, tape-saturated production. Rhodes Piano plays jazzy chords with subtle pitch wobble. Warm Acoustic Guitar adds fingerpicked texture. Soft, lo-fi drums with vinyl crackle and room tone. Chill, intimate, late-night study vibes. Tight groove with a head-nodding swing.",
        weight: 1,
      },
    ],
    config: { bpm: 85, density: 0.5, brightness: 0.4, guidance: 4, temperature: 1.1 },
  },
}

function getFallbackPrompt(mood: MusicMood): PromptSet {
  return {
    ...FALLBACKS[mood],
    prompts: FALLBACKS[mood].prompts.map((prompt) => ({ ...prompt })),
    config: { ...FALLBACKS[mood].config },
  }
}

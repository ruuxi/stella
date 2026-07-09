export type StreamCadenceArrival = readonly [atMs: number, chars: number]

export type StreamCadenceTrace = {
  name: string
  arrivals: readonly StreamCadenceArrival[]
  completeAtMs: number
}

const seededSizes = (
  count: number,
  min: number,
  span: number,
  intervalMs: number,
): StreamCadenceArrival[] => {
  let seed = 0x12345678
  return Array.from({ length: count }, (_, index) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return [index * intervalMs, min + (seed % span)] as const
  })
}

export const STREAM_CADENCE_TRACES: readonly StreamCadenceTrace[] = [
  {
    name: 'single-character trickle',
    arrivals: Array.from({ length: 180 }, (_, index) => [index * 32, 1]),
    completeAtMs: 5_760,
  },
  {
    name: 'normal token deltas',
    arrivals: seededSizes(90, 2, 7, 48),
    completeAtMs: 4_320,
  },
  {
    name: 'sentence bursts',
    arrivals: [
      [0, 84],
      [720, 61],
      [1_510, 103],
      [2_260, 72],
      [3_100, 96],
    ],
    completeAtMs: 3_180,
  },
  {
    name: 'large burst',
    arrivals: [
      [0, 12],
      [180, 2_400],
    ],
    completeAtMs: 260,
  },
  {
    name: 'stall and resume',
    arrivals: [
      [0, 18],
      [45, 24],
      [90, 20],
      [2_450, 310],
      [2_510, 96],
    ],
    completeAtMs: 2_620,
  },
]

/**
 * Captured from a real Stella Claude Code run on 2026-07-09. The renderer saw
 * 242 STREAM events / 1,169 characters over 1,184.7 ms. Adjacent IPC events
 * within 1.5 ms are coalesced here, preserving the distinctive shape: a
 * 98-character opening burst, 589 ms of silence, then a dense 1,071-character
 * tail. Only timing and lengths are retained; response content is irrelevant
 * to the cadence simulation.
 */
export const CLAUDE_CODE_CAPTURED_TRACE: StreamCadenceTrace = {
  name: 'Claude Code captured cadence',
  arrivals: [
    [0, 2], [8.6, 12], [14.1, 19], [20.4, 15], [37, 4], [42.1, 21],
    [62.5, 1], [66.6, 21], [655.9, 7], [720.5, 10], [728.9, 12],
    [735.1, 3], [754.6, 5], [759.5, 13], [782.3, 6], [787.6, 14],
    [839.3, 7], [844.6, 17], [849.4, 16], [879.8, 1], [884.1, 14],
    [888.7, 25], [893.5, 22], [898.5, 9], [902.3, 24], [907.5, 1],
    [911.2, 4], [934.3, 6], [938.2, 12], [943.6, 5], [948.3, 17],
    [955.7, 3], [960.3, 17], [964.3, 4], [967.7, 16], [971.3, 4],
    [975, 53], [979.8, 5], [983.5, 15], [988.1, 19], [991.8, 13],
    [995.8, 3], [997.4, 26], [1_000.1, 23], [1_005.4, 4],
    [1_009.3, 15], [1_019.1, 7], [1_023.7, 44], [1_028.1, 16],
    [1_032.3, 19], [1_037.8, 22], [1_042.7, 10], [1_079.6, 10],
    [1_083.9, 16], [1_088.2, 20], [1_093.2, 22], [1_098.3, 46],
    [1_102.4, 47], [1_106.8, 1], [1_111.8, 39], [1_116.7, 38],
    [1_121.6, 4], [1_126.4, 45], [1_132.1, 60], [1_140.4, 8],
    [1_144.3, 13], [1_148.9, 33], [1_159.6, 8], [1_163.8, 15],
    [1_168.7, 5], [1_173.8, 4], [1_179.8, 18], [1_184.6, 34],
  ],
  completeAtMs: 1_205,
}

export const ALL_STREAM_CADENCE_TRACES: readonly StreamCadenceTrace[] = [
  ...STREAM_CADENCE_TRACES,
  CLAUDE_CODE_CAPTURED_TRACE,
]

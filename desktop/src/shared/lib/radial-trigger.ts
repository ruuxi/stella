type RadialPlatform = "darwin" | "win32" | "linux" | "other"

type SingleTriggerDefinition = {
  kind: "single"
  label: string
  uiohookKeycodes: readonly number[]
}

type ChordTriggerDefinition = {
  kind: "chord"
  labels: Partial<Record<RadialPlatform, string>>
  groupsByPlatform: Partial<Record<RadialPlatform, ReadonlyArray<readonly number[]>>>
}

type RadialTriggerDefinition = SingleTriggerDefinition | ChordTriggerDefinition

const LEFT_ALT = 56
const RIGHT_ALT = 3640
const LEFT_META = 3675
const RIGHT_META = 3676

const RADIAL_TRIGGER_DEFINITIONS = {
  SystemChord: {
    kind: "chord",
    labels: {
      darwin: "Option + Cmd",
      win32: "Alt + Win",
      linux: "Alt + Meta",
      other: "Alt + Meta",
    },
    groupsByPlatform: {
      darwin: [
        [LEFT_ALT, RIGHT_ALT],
        [LEFT_META, RIGHT_META],
      ],
      win32: [
        [LEFT_ALT, RIGHT_ALT],
        [LEFT_META, RIGHT_META],
      ],
      linux: [
        [LEFT_ALT, RIGHT_ALT],
        [LEFT_META, RIGHT_META],
      ],
      other: [
        [LEFT_ALT, RIGHT_ALT],
        [LEFT_META, RIGHT_META],
      ],
    },
  },
  Backquote: { kind: "single", label: "`", uiohookKeycodes: [41] },
  KeyA: { kind: "single", label: "A", uiohookKeycodes: [30] },
  KeyB: { kind: "single", label: "B", uiohookKeycodes: [48] },
  KeyC: { kind: "single", label: "C", uiohookKeycodes: [46] },
  KeyD: { kind: "single", label: "D", uiohookKeycodes: [32] },
  KeyE: { kind: "single", label: "E", uiohookKeycodes: [18] },
  KeyF: { kind: "single", label: "F", uiohookKeycodes: [33] },
  KeyG: { kind: "single", label: "G", uiohookKeycodes: [34] },
  KeyH: { kind: "single", label: "H", uiohookKeycodes: [35] },
  KeyI: { kind: "single", label: "I", uiohookKeycodes: [23] },
  KeyJ: { kind: "single", label: "J", uiohookKeycodes: [36] },
  KeyK: { kind: "single", label: "K", uiohookKeycodes: [37] },
  KeyL: { kind: "single", label: "L", uiohookKeycodes: [38] },
  KeyM: { kind: "single", label: "M", uiohookKeycodes: [50] },
  KeyN: { kind: "single", label: "N", uiohookKeycodes: [49] },
  KeyO: { kind: "single", label: "O", uiohookKeycodes: [24] },
  KeyP: { kind: "single", label: "P", uiohookKeycodes: [25] },
  KeyQ: { kind: "single", label: "Q", uiohookKeycodes: [16] },
  KeyR: { kind: "single", label: "R", uiohookKeycodes: [19] },
  KeyS: { kind: "single", label: "S", uiohookKeycodes: [31] },
  KeyT: { kind: "single", label: "T", uiohookKeycodes: [20] },
  KeyU: { kind: "single", label: "U", uiohookKeycodes: [22] },
  KeyV: { kind: "single", label: "V", uiohookKeycodes: [47] },
  KeyW: { kind: "single", label: "W", uiohookKeycodes: [17] },
  KeyX: { kind: "single", label: "X", uiohookKeycodes: [45] },
  KeyY: { kind: "single", label: "Y", uiohookKeycodes: [21] },
  KeyZ: { kind: "single", label: "Z", uiohookKeycodes: [44] },
  Digit1: { kind: "single", label: "1", uiohookKeycodes: [2] },
  Digit2: { kind: "single", label: "2", uiohookKeycodes: [3] },
  Digit3: { kind: "single", label: "3", uiohookKeycodes: [4] },
  Digit4: { kind: "single", label: "4", uiohookKeycodes: [5] },
  Digit5: { kind: "single", label: "5", uiohookKeycodes: [6] },
  Digit6: { kind: "single", label: "6", uiohookKeycodes: [7] },
  Digit7: { kind: "single", label: "7", uiohookKeycodes: [8] },
  Digit8: { kind: "single", label: "8", uiohookKeycodes: [9] },
  Digit9: { kind: "single", label: "9", uiohookKeycodes: [10] },
  Digit0: { kind: "single", label: "0", uiohookKeycodes: [11] },
  Minus: { kind: "single", label: "-", uiohookKeycodes: [12] },
  Equal: { kind: "single", label: "=", uiohookKeycodes: [13] },
  BracketLeft: { kind: "single", label: "[", uiohookKeycodes: [26] },
  BracketRight: { kind: "single", label: "]", uiohookKeycodes: [27] },
  Backslash: { kind: "single", label: "\\", uiohookKeycodes: [43] },
  Semicolon: { kind: "single", label: ";", uiohookKeycodes: [39] },
  Quote: { kind: "single", label: "'", uiohookKeycodes: [40] },
  Comma: { kind: "single", label: ",", uiohookKeycodes: [51] },
  Period: { kind: "single", label: ".", uiohookKeycodes: [52] },
  Slash: { kind: "single", label: "/", uiohookKeycodes: [53] },
  Space: { kind: "single", label: "Space", uiohookKeycodes: [57] },
  Tab: { kind: "single", label: "Tab", uiohookKeycodes: [15] },
  Enter: { kind: "single", label: "Enter", uiohookKeycodes: [28] },
  Escape: { kind: "single", label: "Escape", uiohookKeycodes: [1] },
} as const satisfies Record<string, RadialTriggerDefinition>

export type RadialTriggerCode = keyof typeof RADIAL_TRIGGER_DEFINITIONS

export const DEFAULT_RADIAL_TRIGGER_CODE: RadialTriggerCode = "SystemChord"

const normalizeRadialPlatform = (value: unknown): RadialPlatform => {
  if (value === "darwin" || value === "win32" || value === "linux") {
    return value
  }
  return "other"
}

export const isSupportedRadialTriggerCode = (
  value: unknown,
): value is RadialTriggerCode =>
  typeof value === "string" && value in RADIAL_TRIGGER_DEFINITIONS

export const normalizeRadialTriggerCode = (
  value: unknown,
): RadialTriggerCode =>
  isSupportedRadialTriggerCode(value) ? value : DEFAULT_RADIAL_TRIGGER_CODE

export const getRadialTriggerLabel = (
  value: unknown,
  platform?: unknown,
): string => {
  const definition = RADIAL_TRIGGER_DEFINITIONS[normalizeRadialTriggerCode(value)]
  if (definition.kind === "single") {
    return definition.label
  }

  const normalizedPlatform = normalizeRadialPlatform(platform)
  return definition.labels[normalizedPlatform] ?? definition.labels.other ?? "Custom"
}

export const getRadialTriggerOptions = (
  platform?: unknown,
): ReadonlyArray<{
  code: RadialTriggerCode
  label: string
}> =>
  (Object.keys(RADIAL_TRIGGER_DEFINITIONS) as RadialTriggerCode[]).map((code) => ({
    code,
    label: getRadialTriggerLabel(code, platform),
  }))

export const isRadialTriggerPressed = (
  value: unknown,
  pressedKeycodes: ReadonlySet<number>,
  platform?: unknown,
): boolean => {
  const definition = RADIAL_TRIGGER_DEFINITIONS[normalizeRadialTriggerCode(value)]
  if (definition.kind === "single") {
    return definition.uiohookKeycodes.some((keycode) => pressedKeycodes.has(keycode))
  }

  const normalizedPlatform = normalizeRadialPlatform(platform)
  const groups =
    definition.groupsByPlatform[normalizedPlatform] ??
    definition.groupsByPlatform.other ??
    []

  return groups.every((group) => group.some((keycode) => pressedKeycodes.has(keycode)))
}

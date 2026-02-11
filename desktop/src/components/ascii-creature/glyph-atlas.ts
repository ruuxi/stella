export const DOT_COUNT = 10; // Number of dot size levels (empty → full)
export const ASPECT = 0.55;
export const BIRTH_DURATION = 12000;
export const FLASH_DURATION = 1200;

export const parseColor = (value: string): [number, number, number] => {
  const match = value
    .trim()
    .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
  if (!match) return [1, 1, 1];
  return [
    Number(match[1]) / 255,
    Number(match[2]) / 255,
    Number(match[3]) / 255,
  ];
};

export const getCssNumber = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const buildGlyphAtlas = (
  _fontFamily: string,
  _fontSize: number,
  glyphWidth: number,
  glyphHeight: number,
) => {
  const canvas = document.createElement("canvas");
  canvas.width = glyphWidth * DOT_COUNT;
  canvas.height = glyphHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";

  const maxRadius = Math.min(glyphWidth, glyphHeight) * 0.45;

  // Slot 0 is empty (no dot). Slots 1–9 draw circles of increasing size.
  for (let i = 1; i < DOT_COUNT; i++) {
    const t = i / (DOT_COUNT - 1);
    const radius = maxRadius * Math.pow(t, 0.7);
    if (radius >= 0.5) {
      const cx = i * glyphWidth + glyphWidth / 2;
      const cy = glyphHeight / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return canvas;
};

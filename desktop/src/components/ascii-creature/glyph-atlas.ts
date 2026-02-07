export const CHARS = " .:-=+*#%@"; // Ordered by apparent brightness
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
  fontFamily: string,
  fontSize: number,
  glyphWidth: number,
  glyphHeight: number,
) => {
  const canvas = document.createElement("canvas");
  canvas.width = glyphWidth * CHARS.length;
  canvas.height = glyphHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.imageSmoothingEnabled = false;
  ctx.font = `${fontSize}px ${fontFamily}`;

  for (let i = 0; i < CHARS.length; i++) {
    ctx.fillText(CHARS[i], i * glyphWidth, 0);
  }

  return canvas;
};

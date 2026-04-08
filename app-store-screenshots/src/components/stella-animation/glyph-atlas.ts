export const DOT_COUNT = 10;
export const BIRTH_DURATION = 12000;
export const FLASH_DURATION = 1200;

export const parseColor = (value: string): [number, number, number] => {
  const normalized = value.trim();

  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);

    if (hex.length === 3) {
      return [
        Number.parseInt(hex[0] + hex[0], 16) / 255,
        Number.parseInt(hex[1] + hex[1], 16) / 255,
        Number.parseInt(hex[2] + hex[2], 16) / 255,
      ];
    }

    if (hex.length >= 6) {
      return [
        Number.parseInt(hex.slice(0, 2), 16) / 255,
        Number.parseInt(hex.slice(2, 4), 16) / 255,
        Number.parseInt(hex.slice(4, 6), 16) / 255,
      ];
    }
  }

  const match = normalized.match(
    /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i,
  );

  if (!match) {
    return [1, 1, 1];
  }

  return [
    Number(match[1]) / 255,
    Number(match[2]) / 255,
    Number(match[3]) / 255,
  ];
};

let cachedAtlas: { canvas: HTMLCanvasElement; key: string } | null = null;

export const buildGlyphAtlas = (
  glyphWidth: number,
  glyphHeight: number,
  fontFamily: string,
  fontSize: number,
) => {
  const key = `${glyphWidth}x${glyphHeight}:${fontFamily}:${fontSize}`;

  if (cachedAtlas?.key === key) {
    return cachedAtlas.canvas;
  }

  const canvas = document.createElement("canvas");
  canvas.width = glyphWidth * DOT_COUNT;
  canvas.height = glyphHeight;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";

  const maxRadius = Math.min(glyphWidth, glyphHeight) * 0.45;
  context.font = `${fontSize}px ${fontFamily}`;

  for (let index = 1; index < DOT_COUNT; index += 1) {
    const t = index / (DOT_COUNT - 1);
    const radius = maxRadius * Math.pow(t, 0.7);

    if (radius >= 0.5) {
      const centerX = index * glyphWidth + glyphWidth / 2;
      const centerY = glyphHeight / 2;
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  cachedAtlas = { canvas, key };
  return canvas;
};

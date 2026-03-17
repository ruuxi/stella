const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

/**
 * Generate the Stella globe icon — a sphere of dots with a blue-purple-cyan-green
 * radial gradient, matching the stella-logo.svg aesthetic.
 */

// Gradient stops (radial from center): blue → purple → cyan → green
const GRADIENT_STOPS = [
  { pos: 0.0,  r: 0x7a, g: 0xa2, b: 0xf7 },  // #7aa2f7
  { pos: 0.33, r: 0xbb, g: 0x9a, b: 0xf7 },  // #bb9af7
  { pos: 0.66, r: 0x7d, g: 0xcf, b: 0xff },  // #7dcfff
  { pos: 1.0,  r: 0x9e, g: 0xce, b: 0x6a },  // #9ece6a
];

function lerpColor(t) {
  t = Math.max(0, Math.min(1, t));
  // Find the two stops to interpolate between
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i++) {
    const a = GRADIENT_STOPS[i];
    const b = GRADIENT_STOPS[i + 1];
    if (t >= a.pos && t <= b.pos) {
      const f = (t - a.pos) / (b.pos - a.pos);
      return {
        r: Math.round(a.r + (b.r - a.r) * f),
        g: Math.round(a.g + (b.g - a.g) * f),
        b: Math.round(a.b + (b.b - a.b) * f),
      };
    }
  }
  const last = GRADIENT_STOPS[GRADIENT_STOPS.length - 1];
  return { r: last.r, g: last.g, b: last.b };
}

function generatePNG(size) {
  const rowBytes = 1 + size * 4;
  const rawData = Buffer.alloc(rowBytes * size, 0);

  const cx = size / 2;
  const cy = size / 2;
  const sphereRadius = size / 2 - 1;

  // Dot grid parameters scale with icon size
  const dotSpacing = Math.max(2, size / 16);
  const maxDotRadius = Math.max(0.8, size / 48);

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowBytes;
    rawData[rowOffset] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const px = rowOffset + 1 + x * 4;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distFromCenter = Math.sqrt(dx * dx + dy * dy);
      const normalizedDist = distFromCenter / sphereRadius;

      if (normalizedDist > 1.05) {
        // Outside sphere — transparent
        continue;
      }

      // Find nearest dot center on the grid
      const gridX = Math.round((x + 0.5) / dotSpacing) * dotSpacing;
      const gridY = Math.round((y + 0.5) / dotSpacing) * dotSpacing;
      const gdx = gridX - cx;
      const gdy = gridY - cy;
      const gridDistFromCenter = Math.sqrt(gdx * gdx + gdy * gdy);
      const gridNormalizedDist = gridDistFromCenter / sphereRadius;

      // Only draw dots that are inside the sphere
      if (gridNormalizedDist > 1.0) continue;

      // Distance from pixel to nearest dot center
      const dotDx = (x + 0.5) - gridX;
      const dotDy = (y + 0.5) - gridY;
      const distFromDot = Math.sqrt(dotDx * dotDx + dotDy * dotDy);

      // Dot radius increases toward center (3D sphere effect)
      const depthFactor = Math.sqrt(1 - gridNormalizedDist * gridNormalizedDist);
      const dotRadius = maxDotRadius * (0.3 + 0.7 * depthFactor);

      if (distFromDot > dotRadius + 0.5) continue;

      // Gradient color based on distance from center
      const color = lerpColor(gridNormalizedDist);

      // Opacity: dots near center are more opaque (3D depth)
      const baseOpacity = 0.3 + 0.7 * depthFactor;

      // Anti-aliasing at dot edges
      const edgeDist = dotRadius - distFromDot;
      const aaAlpha = Math.max(0, Math.min(1, edgeDist + 0.5));

      const alpha = baseOpacity * aaAlpha;

      rawData[px + 0] = color.r;
      rawData[px + 1] = color.g;
      rawData[px + 2] = color.b;
      rawData[px + 3] = Math.round(alpha * 255);
    }
  }

  // Compress and build PNG
  const compressed = zlib.deflateSync(rawData);
  const chunks = [];

  // PNG signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(makeChunk("IHDR", ihdr));

  // IDAT
  chunks.push(makeChunk("IDAT", compressed));

  // IEND
  chunks.push(makeChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcInput);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xedb88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Generate all three sizes
const sizes = [16, 48, 128];
const outDir = __dirname;

for (const size of sizes) {
  const png = generatePNG(size);
  const filePath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created icon${size}.png (${png.length} bytes)`);
}

console.log("Done! Stella globe icons generated.");

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

// Generate a minimal valid PNG file with a green circle on transparent background
function generatePNG(size) {
  // Each row: filter byte (0) + RGBA pixels (4 bytes each)
  const rowBytes = 1 + size * 4;
  const rawData = Buffer.alloc(rowBytes * size, 0);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 1;

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowBytes;
    rawData[rowOffset] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const px = rowOffset + 1 + x * 4;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius) {
        // Green dot with slight anti-aliasing at edges
        const edgeDist = radius - dist;
        const alpha = Math.min(1, edgeDist * 2);
        rawData[px + 0] = 0x22; // R
        rawData[px + 1] = 0xc5; // G
        rawData[px + 2] = 0x5e; // B
        rawData[px + 3] = Math.round(alpha * 255); // A
      } else {
        // Transparent
        rawData[px + 0] = 0;
        rawData[px + 1] = 0;
        rawData[px + 2] = 0;
        rawData[px + 3] = 0;
      }
    }
  }

  // Compress the raw pixel data
  const compressed = zlib.deflateSync(rawData);

  // Build PNG file
  const chunks = [];

  // PNG signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(makeChunk("IHDR", ihdr));

  // IDAT chunk
  chunks.push(makeChunk("IDAT", compressed));

  // IEND chunk
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

// CRC-32 implementation for PNG
function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
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

console.log("Done! All icons generated.");

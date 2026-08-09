const fs = require("fs");
const path = require("path");

/**
 * The extension icons are curated derivatives of the canonical Stella brand
 * master. Keep them committed as binary assets; procedurally redrawing the mark
 * would change its geometry. This script validates the checked-in sizes instead.
 */
const sizes = [16, 48, 128];

for (const size of sizes) {
  const filePath = path.join(__dirname, `icon${size}.png`);
  const png = fs.readFileSync(filePath);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);

  if (width !== size || height !== size) {
    throw new Error(`${path.basename(filePath)} must be ${size}x${size}, got ${width}x${height}`);
  }

  console.log(`Validated icon${size}.png (${width}x${height})`);
}

console.log("Done! Curated Stella extension icons are valid.");

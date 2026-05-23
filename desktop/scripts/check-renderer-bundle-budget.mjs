import fs from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");
const assetsDir = path.join(distDir, "assets");

const budgets = {
  maxJsAssetBytes: 2_000_000,
  maxCssAssetBytes: 400_000,
  maxRendererBytes: 24_000_000,
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
};

const walkFiles = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(target);
    if (!entry.isFile()) return [];
    return [target];
  });
};

if (!fs.existsSync(distDir) || !fs.existsSync(assetsDir)) {
  throw new Error(
    "Renderer dist is missing. Run vite build before bundle budget checks.",
  );
}

const files = walkFiles(distDir).map((file) => {
  const stat = fs.statSync(file);
  return {
    file,
    relative: path.relative(distDir, file),
    size: stat.size,
  };
});

const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
const jsAssets = files.filter((file) => file.relative.endsWith(".js"));
const cssAssets = files.filter((file) => file.relative.endsWith(".css"));
const largestJs = jsAssets.reduce(
  (largest, file) => (file.size > largest.size ? file : largest),
  { size: 0, relative: "" },
);
const largestCss = cssAssets.reduce(
  (largest, file) => (file.size > largest.size ? file : largest),
  { size: 0, relative: "" },
);

const failures = [];
if (largestJs.size > budgets.maxJsAssetBytes) {
  failures.push(
    `Largest JS asset ${largestJs.relative} is ${formatBytes(largestJs.size)}; budget is ${formatBytes(budgets.maxJsAssetBytes)}.`,
  );
}
if (largestCss.size > budgets.maxCssAssetBytes) {
  failures.push(
    `Largest CSS asset ${largestCss.relative} is ${formatBytes(largestCss.size)}; budget is ${formatBytes(budgets.maxCssAssetBytes)}.`,
  );
}
if (totalBytes > budgets.maxRendererBytes) {
  failures.push(
    `Renderer dist is ${formatBytes(totalBytes)}; budget is ${formatBytes(budgets.maxRendererBytes)}.`,
  );
}

console.log(
  [
    `Renderer dist: ${formatBytes(totalBytes)}`,
    `Largest JS: ${largestJs.relative || "none"} ${formatBytes(largestJs.size)}`,
    `Largest CSS: ${largestCss.relative || "none"} ${formatBytes(largestCss.size)}`,
  ].join("\n"),
);

if (failures.length > 0) {
  throw new Error(`Bundle budget exceeded:\n${failures.join("\n")}`);
}

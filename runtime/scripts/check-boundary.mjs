import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const runtimeRoot = path.resolve(import.meta.dirname, "..");
const importFromDesktopPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["'][^"']*desktop\/src\/[^"']*["']|\bimport\(\s*["'][^"']*desktop\/src\/[^"']*["']\s*\)/;

const ignoredDirectories = new Set(["node_modules"]);

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (entry.isFile() && absolutePath.endsWith(".ts")) {
      files.push(absolutePath);
    }
  }

  return files;
};

const offenders = [];

for (const file of await walk(runtimeRoot)) {
  const text = await readFile(file, "utf8");
  if (importFromDesktopPattern.test(text)) {
    offenders.push(path.relative(runtimeRoot, file));
  }
}

if (offenders.length > 0) {
  console.error("Runtime must not import desktop source files:");
  for (const offender of offenders) {
    console.error(`- ${offender}`);
  }
  process.exit(1);
}

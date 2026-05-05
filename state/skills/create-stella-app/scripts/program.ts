#!/usr/bin/env bun
/**
 * Scaffold a new sidebar app inside Stella's desktop renderer.
 *
 * Creates these files (none of which already exist) by copying the
 * sibling `templates/*.tmpl` files with placeholder substitution:
 *
 *   desktop/src/app/<id>/metadata.ts
 *   desktop/src/app/<id>/App.tsx
 *   desktop/src/app/<id>/<Component>View.tsx
 *   desktop/src/app/<id>/<id>.css
 *   desktop/src/routes/<id>.tsx
 *
 * Vite + the TanStack Router plugin pick the new route up via HMR; the
 * sidebar discovers the new entry through `import.meta.glob`. No edits
 * to the Sidebar component or any registry are required.
 *
 * Usage:
 *   bun <abs path>/program.ts <id> <label> [--slot top|bottom]
 *                                          [--order N]
 *                                          [--icon CustomLayout]
 *
 * The `--icon` value must be one of the components currently exported
 * from `desktop/src/shell/sidebar/SidebarIcons.tsx`. The script lists
 * them in the error message if you pass an unknown one. To use a brand
 * new icon, add it to `SidebarIcons.tsx` first (one `apply_patch`),
 * then run this script with `--icon Custom<Name>`.
 *
 * The script never overwrites existing files. It exits non-zero with
 * a clear message if any target already exists, the id is taken, or
 * the icon doesn't resolve.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const TEMPLATE_DIR = resolve(SCRIPT_DIR, "..", "templates");

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function findRepoRoot(start: string): string | null {
  let dir = start;
  while (dir !== "/") {
    if (
      existsSync(join(dir, "desktop", "src", "app", "_shared", "app-metadata.ts"))
    ) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

// Resolve from the caller's cwd first so this scaffolds into whichever
// Stella tree invoked it, not whichever tree contains this script.
const REPO_ROOT =
  findRepoRoot(process.cwd()) ??
  findRepoRoot(SCRIPT_DIR) ??
  fail(
    "could not locate Stella repo root from cwd or script dir " +
      "(no desktop/src/app/_shared found). cd into the Stella install root " +
      "and re-run.",
  );
const APP_DIR = join(REPO_ROOT, "desktop/src/app");
const ROUTES_DIR = join(REPO_ROOT, "desktop/src/routes");
const ICONS_FILE = join(REPO_ROOT, "desktop/src/shell/sidebar/SidebarIcons.tsx");

interface Args {
  id: string;
  label: string;
  slot: "top" | "bottom";
  order: number;
  icon: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let slot: "top" | "bottom" = "top";
  let order = 50;
  let icon = "CustomLayout";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--slot") {
      const v = argv[++i];
      if (v !== "top" && v !== "bottom") fail(`--slot must be "top" or "bottom", got ${JSON.stringify(v)}`);
      slot = v;
    } else if (arg === "--order") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) fail(`--order must be a number`);
      order = v;
    } else if (arg === "--icon") {
      icon = String(argv[++i] ?? "");
    } else if (arg.startsWith("--")) {
      fail(`unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [id, ...labelParts] = positional;
  if (!id) {
    fail(
      'missing <id>. usage: bun program.ts <id> <label> [--slot top|bottom] [--order N] [--icon CustomLayout]',
    );
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    fail(`invalid id ${JSON.stringify(id)}: must be lowercase, start with a letter, only [a-z0-9-], <=32 chars`);
  }
  const label = labelParts.join(" ").trim();
  if (!label) fail("missing <label>");

  return { id, label, slot, order, icon };
}

function listExportedIcons(): string[] {
  const src = readFileSync(ICONS_FILE, "utf8");
  const out: string[] = [];
  const re = /export\s+const\s+(Custom[A-Za-z0-9]+)\s*=/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) out.push(match[1]!);
  return out;
}

function componentName(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function fillTemplate(rel: string, vars: Record<string, string>): string {
  const tmpl = readFileSync(join(TEMPLATE_DIR, rel), "utf8");
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined) fail(`template ${rel}: missing var ${k}`);
    return v;
  });
}

function writeNew(path: string, contents: string): void {
  if (existsSync(path)) fail(`refusing to overwrite ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`created ${path}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const icons = listExportedIcons();
  if (!icons.includes(args.icon)) {
    fail(
      `icon ${JSON.stringify(args.icon)} is not exported from SidebarIcons.tsx.\n` +
        `available: ${icons.join(", ")}\n` +
        `to add a new icon, edit ${ICONS_FILE} first, then re-run this script.`,
    );
  }

  const appDir = join(APP_DIR, args.id);
  const routeFile = join(ROUTES_DIR, `${args.id}.tsx`);
  if (existsSync(appDir)) fail(`app directory already exists: ${appDir}`);
  if (existsSync(routeFile)) fail(`route file already exists: ${routeFile}`);

  const Component = componentName(args.id);
  const vars: Record<string, string> = {
    ID: args.id,
    LABEL: args.label,
    ICON: args.icon,
    SLOT: args.slot,
    ORDER: String(args.order),
    COMPONENT: Component,
  };

  writeNew(join(appDir, "metadata.ts"), fillTemplate("metadata.ts.tmpl", vars));
  writeNew(join(appDir, "App.tsx"), fillTemplate("App.tsx.tmpl", vars));
  writeNew(join(appDir, `${Component}View.tsx`), fillTemplate("View.tsx.tmpl", vars));
  writeNew(join(appDir, `${args.id}.css`), fillTemplate("style.css.tmpl", vars));
  writeNew(routeFile, fillTemplate("route.tsx.tmpl", vars));

  console.log("");
  console.log(`scaffolded sidebar app "${args.label}" (id=${args.id}, slot=${args.slot}, order=${args.order})`);
  console.log("next steps:");
  console.log(`  1. replace ${Component}View.tsx body with the real surface`);
  console.log("  2. validate:");
  console.log("     bunx --package typescript@5.9.3 tsc -p desktop/tsconfig.app.json --noEmit");
  console.log(
    "     bun run test:run -- tests/runtime/sidebar-discovery.test.ts tests/runtime/route-smoke.test.ts",
  );
}

main();

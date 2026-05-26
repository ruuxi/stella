#!/usr/bin/env bun
/**
 * Scaffold a new single-file Stella app under desktop/src/app/_user/.
 *
 * Creates exactly one file by copying templates/app.tsx.tmpl with
 * placeholder substitution:
 *
 *   desktop/src/app/_user/<slug>.tsx
 *
 * The file exports `default function App()` (the component) and a
 * named `meta = { label, createdAt }` consumed by the apps page
 * (`/apps`) for listing/sorting and by the dynamic route
 * (`/apps/<slug>`) for rendering. No metadata.ts, no separate view,
 * no separate CSS, no per-app route file. Split things off only if
 * the file actually outgrows itself.
 *
 * Usage:
 *   bun <abs path>/program.ts <slug> <label words...>
 *
 * The script never overwrites existing files. It exits non-zero with
 * a clear message if the slug is invalid or the target already exists.
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

const USER_APPS_DIR = join(REPO_ROOT, "desktop/src/app/_user");

interface Args {
  slug: string;
  label: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      fail(`unknown flag: ${arg} (this scaffold takes <slug> <label> only)`);
    }
    positional.push(arg);
  }

  const [slug, ...labelParts] = positional;
  if (!slug) {
    fail("missing <slug>. usage: bun program.ts <slug> <label words...>");
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(slug)) {
    fail(
      `invalid slug ${JSON.stringify(slug)}: must be lowercase, start with a letter, only [a-z0-9-], <=32 chars`,
    );
  }
  const label = labelParts.join(" ").trim();
  if (!label) fail("missing <label>");

  return { slug, label };
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

function escapeForJsString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const targetFile = join(USER_APPS_DIR, `${args.slug}.tsx`);
  if (existsSync(targetFile)) fail(`app file already exists: ${targetFile}`);

  const vars: Record<string, string> = {
    SLUG: args.slug,
    LABEL: escapeForJsString(args.label),
    CREATED_AT: new Date().toISOString(),
  };

  writeNew(targetFile, fillTemplate("app.tsx.tmpl", vars));

  console.log("");
  console.log(
    `scaffolded user app "${args.label}" at desktop/src/app/_user/${args.slug}.tsx`,
  );
  console.log(`it will show up on the /apps page and open at /apps/${args.slug}.`);
  console.log("next steps:");
  console.log(`  1. replace the stub body of ${args.slug}.tsx with the real surface`);
  console.log("  2. validate (run from the Stella install root):");
  console.log("     tsgo -p desktop/tsconfig.app.json --noEmit");
}

main();

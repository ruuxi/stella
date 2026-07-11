import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePackagedPromptSiteUrl } from "../../electron/prompt-site-config.js";

const roots = new Set<string>();
const originalEnvironment = {
  STELLA_CONVEX_SITE_URL: process.env.STELLA_CONVEX_SITE_URL,
  CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
  VITE_CONVEX_SITE_URL: process.env.VITE_CONVEX_SITE_URL,
};

const tempDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-prompt-site-"));
  roots.add(root);
  return root;
};

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("packaged prompt site configuration", () => {
  it("reads the launcher-written desktop environment before renderer startup", async () => {
    delete process.env.STELLA_CONVEX_SITE_URL;
    delete process.env.CONVEX_SITE_URL;
    delete process.env.VITE_CONVEX_SITE_URL;
    const root = await tempDir();
    await mkdir(path.join(root, "desktop"), { recursive: true });
    await writeFile(
      path.join(root, "desktop", ".env.local"),
      "VITE_CONVEX_SITE_URL=https://cloud.stella.sh/\n",
      "utf-8",
    );
    expect(resolvePackagedPromptSiteUrl(root)).toBe("https://cloud.stella.sh");
  });

  it("prefers an explicit main-process environment override", async () => {
    process.env.STELLA_CONVEX_SITE_URL = "https://override.stella.test/";
    const root = await tempDir();
    expect(resolvePackagedPromptSiteUrl(root)).toBe(
      "https://override.stella.test",
    );
  });
});

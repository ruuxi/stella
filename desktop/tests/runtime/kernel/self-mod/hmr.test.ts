import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelfModHmrController } from "../../../../../runtime/kernel/self-mod/hmr.js";

const tempRoots: string[] = [];

const makeTempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-hmr-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("self-mod HMR controller", () => {
  it("reports apply failure when the Vite endpoint is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("missing", { status: 404 }),
    ) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(
        controller.apply([
          {
            runId: "run-a",
            paths: ["desktop/src/foo.tsx"],
            files: [{ path: "desktop/src/foo.tsx", content: "export const a = 1" }],
            restartRelevantPaths: [],
            fullReloadRelevantPaths: [],
          },
        ]),
      ).resolves.toEqual({ ok: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports track failure when the Vite endpoint cannot pin paths", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/pause-client-updates")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;
    const root = makeTempRoot();
    const filePath = path.join(root, "desktop/src/foo.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const a = 1;\n");
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      await expect(controller.recordWrite("run-a", [filePath])).rejects.toThrow(
        "Failed to pin self-mod HMR paths before write.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not pin Vite paths for writes that arrive after a run is finalized", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const root = makeTempRoot();
    const filePath = path.join(root, "desktop/src/stale.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'stale';\n");
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      expect(controller.finalize("run-a").appliedRuns).toEqual([]);
      await controller.recordWrite("run-a", [filePath]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toContain(
        "/__stella/self-mod/hmr/pause-client-updates",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("tracks restart-required paths without posting them to Vite pinning", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const root = makeTempRoot();
    const packageJsonPath = path.join(root, "package.json");
    writeFileSync(packageJsonPath, '{"name":"stella-test"}\n');
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      await controller.recordWrite("run-a", [packageJsonPath]);
      const result = controller.finalize("run-a");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toContain(
        "/__stella/self-mod/hmr/pause-client-updates",
      );
      expect(result.appliedRuns).toHaveLength(1);
      expect(result.appliedRuns[0]!.paths).toEqual(["package.json"]);
      expect(result.appliedRuns[0]!.restartRelevantPaths).toEqual([
        "package.json",
      ]);
      expect(result.hasRestartRelevantPaths).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes the generated route tree when a route file changes", async () => {
    const root = makeTempRoot();
    const routePath = path.join(root, "desktop/src/routes/snake.tsx");
    const routeTreePath = path.join(root, "desktop/src/routeTree.gen.ts");
    mkdirSync(path.dirname(routePath), { recursive: true });
    writeFileSync(routePath, "export const Route = null;\n");
    writeFileSync(routeTreePath, "export const routeTree = 'generated';\n");
    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.recordWrite("run-a", [routePath]);
    const result = controller.finalize("run-a");

    expect(result.appliedRuns).toHaveLength(1);
    expect(result.appliedRuns[0]!.paths).toEqual([
      "desktop/src/routes/snake.tsx",
      "desktop/src/routeTree.gen.ts",
    ]);
    expect(result.appliedRuns[0]!.files).toEqual([
      {
        path: "desktop/src/routes/snake.tsx",
        content: "export const Route = null;\n",
      },
      {
        path: "desktop/src/routeTree.gen.ts",
        content: "export const routeTree = 'generated';\n",
      },
    ]);
  });

  it("captures the generated route tree at finalize time", async () => {
    const root = makeTempRoot();
    const routePath = path.join(root, "desktop/src/routes/snake.tsx");
    const routeTreePath = path.join(root, "desktop/src/routeTree.gen.ts");
    mkdirSync(path.dirname(routePath), { recursive: true });
    writeFileSync(routePath, "export const Route = null;\n");
    writeFileSync(routeTreePath, "export const routeTree = 'stale';\n");
    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.recordWrite("run-a", [routePath]);
    writeFileSync(routeTreePath, "export const routeTree = 'fresh';\n");
    const result = controller.finalize("run-a");

    expect(result.appliedRuns[0]!.files).toContainEqual({
      path: "desktop/src/routeTree.gen.ts",
      content: "export const routeTree = 'fresh';\n",
    });
  });

  it("untracks a path if the run finalizes while Vite tracking is in flight", async () => {
    const originalFetch = globalThis.fetch;
    const root = makeTempRoot();
    const filePath = path.join(root, "desktop/src/race.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'race';\n");
    const requestedPaths: string[] = [];
    let controller: ReturnType<typeof createSelfModHmrController>;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      requestedPaths.push(new URL(url).pathname);
      if (url.endsWith("/track-paths")) {
        controller.finalize("run-a");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      await controller.recordWrite("run-a", [filePath]);
      expect(requestedPaths).toEqual([
        "/__stella/self-mod/hmr/pause-client-updates",
        "/__stella/self-mod/hmr/track-paths",
        "/__stella/self-mod/hmr/untrack-paths",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards full-reload suppression to the Vite apply endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown = null;
    globalThis.fetch = vi.fn(async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(
        controller.apply(
          [
            {
              runId: "run-a",
              paths: ["desktop/src/foo.tsx"],
              files: [
                { path: "desktop/src/foo.tsx", content: "export const a = 1" },
              ],
              restartRelevantPaths: [],
              fullReloadRelevantPaths: ["desktop/src/foo.tsx"],
            },
          ],
          { suppressClientFullReload: true },
        ),
      ).resolves.toEqual({ ok: true });
      expect(body).toMatchObject({
        options: { suppressClientFullReload: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards forced client full reload to the Vite apply endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown = null;
    globalThis.fetch = vi.fn(async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(
        controller.apply(
          [
            {
              runId: "run-a",
              paths: ["desktop/index.html"],
              files: [
                { path: "desktop/index.html", content: "<html></html>\n" },
              ],
              restartRelevantPaths: [],
              fullReloadRelevantPaths: ["desktop/index.html"],
            },
          ],
          { forceClientFullReload: true },
        ),
      ).resolves.toEqual({ ok: true });
      expect(body).toMatchObject({
        options: { forceClientFullReload: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discards only Vite-trackable paths after a failed apply", async () => {
    const originalFetch = globalThis.fetch;
    let body: unknown = null;
    globalThis.fetch = vi.fn(async (_input, init) => {
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: makeTempRoot(),
    });

    try {
      await expect(
        controller.discard([
          {
            runId: "run-a",
            paths: ["desktop/src/foo.tsx", "package.json"],
            files: [
              { path: "desktop/src/foo.tsx", content: "export const a = 1" },
              { path: "package.json", content: '{"name":"x"}\n' },
            ],
            restartRelevantPaths: ["package.json"],
            fullReloadRelevantPaths: [],
          },
        ]),
      ).resolves.toBe(true);
      expect(body).toEqual({ paths: ["desktop/src/foo.tsx"] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not use pre-write tracking content as the applied snapshot", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "desktop/src/foo.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'before';\n");
    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.recordWrite("run-a", [filePath], {
      captureSnapshot: false,
    });
    writeFileSync(filePath, "export const value = 'after';\n");
    await controller.recordWrite("run-a", [filePath]);
    const result = controller.finalize("run-a");

    expect(result.appliedRuns).toHaveLength(1);
    expect(result.appliedRuns[0]!.files).toEqual([
      {
        path: "desktop/src/foo.tsx",
        content: "export const value = 'after';\n",
      },
    ]);
  });

  it("snapshots already-owned post-write paths before tracking newly owned paths", async () => {
    const originalFetch = globalThis.fetch;
    const root = makeTempRoot();
    const oldPath = path.join(root, "desktop/src/old.tsx");
    const newPath = path.join(root, "desktop/src/new.tsx");
    mkdirSync(path.dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, "export const value = 'before';\n");
    writeFileSync(newPath, "export const value = 'new';\n");
    let mutateDuringTrack = false;
    globalThis.fetch = vi.fn(async () => {
      if (mutateDuringTrack) {
        writeFileSync(oldPath, "export const value = 'overwritten';\n");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const controller = createSelfModHmrController({
      enabled: true,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    try {
      await controller.beginRun("run-a");
      await controller.recordWrite("run-a", [oldPath], {
        captureSnapshot: false,
      });
      writeFileSync(oldPath, "export const value = 'after';\n");
      mutateDuringTrack = true;
      await controller.recordWrite("run-a", [oldPath, newPath]);
      const result = controller.finalize("run-a");

      expect(result.appliedRuns).toHaveLength(1);
      expect(result.appliedRuns[0]!.files).toEqual([
        {
          path: "desktop/src/old.tsx",
          content: "export const value = 'after';\n",
        },
        {
          path: "desktop/src/new.tsx",
          content: "export const value = 'new';\n",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("applies a held run's finalize-time snapshot when an overlapping run cancels", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "desktop/src/foo.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'a';\n");

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.beginRun("run-b");
    await controller.recordWrite("run-a", [filePath]);
    await controller.recordWrite("run-b", [filePath]);

    expect(controller.finalize("run-a").appliedRuns).toEqual([]);

    writeFileSync(filePath, "export const value = 'cancelled-b';\n");
    await controller.recordWrite("run-b", [filePath]);
    const cancelResult = await controller.cancel("run-b");

    expect(cancelResult.appliedRuns).toHaveLength(1);
    expect(cancelResult.appliedRuns[0]!.runId).toBe("run-a");
    expect(cancelResult.appliedRuns[0]!.files).toEqual([
      {
        path: "desktop/src/foo.tsx",
        content: "export const value = 'a';\n",
      },
    ]);
  });

  it("represents finalized deletes as a missing file instead of an empty module", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "desktop/src/delete-me.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'present';\n");

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    unlinkSync(filePath);
    await controller.recordWrite("run-a", [filePath]);
    const result = controller.finalize("run-a");

    expect(result.appliedRuns).toHaveLength(1);
    expect(result.appliedRuns[0]!.files).toEqual([
      {
        path: "desktop/src/delete-me.tsx",
        deleted: true,
      },
    ]);
  });

  it("does not let a cancelled recreate override a held delete", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "desktop/src/delete-held.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const value = 'present';\n");

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.beginRun("run-b");
    unlinkSync(filePath);
    await controller.recordWrite("run-a", [filePath]);
    await controller.recordWrite("run-b", [filePath]);

    expect(controller.finalize("run-a").appliedRuns).toEqual([]);

    writeFileSync(filePath, "export const value = 'cancelled-b';\n");
    await controller.recordWrite("run-b", [filePath]);
    const cancelResult = await controller.cancel("run-b");

    expect(cancelResult.appliedRuns).toHaveLength(1);
    expect(cancelResult.appliedRuns[0]!.files).toEqual([
      {
        path: "desktop/src/delete-held.tsx",
        deleted: true,
      },
    ]);
  });

  it("does not let an earlier overlapping cancellation pollute a held run snapshot", async () => {
    const root = makeTempRoot();
    const filePath = path.join(root, "desktop/src/early-overlap.tsx");
    mkdirSync(path.dirname(filePath), { recursive: true });

    const controller = createSelfModHmrController({
      enabled: false,
      getDevServerUrl: () => "http://127.0.0.1:57314",
      repoRoot: root,
    });

    await controller.beginRun("run-a");
    await controller.beginRun("run-b");

    writeFileSync(filePath, "export const value = 'a';\n");
    await controller.recordWrite("run-a", [filePath]);

    writeFileSync(filePath, "export const value = 'b-cancelled';\n");
    await controller.recordWrite("run-b", [filePath]);

    expect(controller.finalize("run-a").appliedRuns).toEqual([]);
    const cancelResult = await controller.cancel("run-b");

    expect(cancelResult.appliedRuns).toHaveLength(1);
    expect(cancelResult.appliedRuns[0]!.files).toEqual([
      {
        path: "desktop/src/early-overlap.tsx",
        content: "export const value = 'a';\n",
      },
    ]);
  });
});

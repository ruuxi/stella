import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAppliedReleaseManifest } from "../../../electron/ipc/updates-handlers.js";

const roots = new Set<string>();
const servers = new Set<http.Server>();

const listen = (server: http.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test server did not bind to a TCP port."));
        return;
      }
      resolve(address.port);
    });
  });

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("writeAppliedReleaseManifest", () => {
  it("refreshes stella-release.json to the applied desktop release", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-release-record-"));
    roots.add(root);
    const release = {
      schemaVersion: 1,
      tag: "desktop-v1.2.3",
      version: "1.2.3",
      platform: "darwin-arm64",
      commit: "b".repeat(40),
      files: {
        "package.json": {
          sha256: "abc",
          size: 2,
        },
      },
      publishedAt: "2026-05-31T00:00:00.000Z",
    };
    const server = http.createServer((request, response) => {
      if (request.url !== "/desktop-v1.2.3/manifest.json") {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(release));
    });
    servers.add(server);
    const port = await listen(server);

    await expect(
      writeAppliedReleaseManifest(root, release.commit, release.tag, {
        releaseManifestBaseUrl: `http://127.0.0.1:${port}`,
      }),
    ).resolves.toBe(true);

    await expect(
      readFile(path.join(root, "stella-release.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      tag: "desktop-v1.2.3",
      commit: release.commit,
      files: {
        "package.json": {
          sha256: "abc",
        },
      },
    });
  });

  it("rejects a manifest for a different commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-release-record-"));
    roots.add(root);
    const server = http.createServer((_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            schemaVersion: 1,
            tag: "desktop-v1.2.3",
            commit: "c".repeat(40),
            files: { "package.json": { sha256: "abc" } },
          }),
        );
    });
    servers.add(server);
    const port = await listen(server);

    await expect(
      writeAppliedReleaseManifest(root, "b".repeat(40), "desktop-v1.2.3", {
        releaseManifestBaseUrl: `http://127.0.0.1:${port}`,
      }),
    ).rejects.toThrow(
      "Release manifest commit did not match the applied release.",
    );
  });
});

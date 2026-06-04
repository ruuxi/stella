import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoreOperations } from "../../../../../runtime/kernel/runner/store-operations.js";
import type { StorePackageRecord } from "../../../../../runtime/contracts/index.js";

const refs = {
  data: {
    store_packages: {
      createFirstRelease: "createFirstRelease",
      createUpdateRelease: "createUpdateRelease",
      getPublicPackage: "getPublicPackage",
      getPublicRelease: "getPublicRelease",
      listPackages: "listPackages",
      listPublicReleases: "listPublicReleases",
    },
    store_git_artifacts: {
      prepareGitObjectUploads: "prepareGitObjectUploads",
      verifyGitObjectUploads: "verifyGitObjectUploads",
      prepareDiffUpload: "prepareDiffUpload",
      getReleaseDiff: "getReleaseDiff",
      getReleaseCommits: "getReleaseCommits",
    },
  },
};

const packageRecord: StorePackageRecord = {
  packageId: "large-pack",
  category: "customization",
  displayName: "Large Pack",
  latestReleaseNumber: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe("Store runner git-artifact publishing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads object URLs and the squashed diff, then publishes a ref-only release", async () => {
    const objectUpload = {
      sha: "a".repeat(40),
      type: "blob" as const,
      sizeBytes: 4,
      compressedBytes: new Uint8Array([1, 2, 3, 4]),
    };
    const actionCalls: Array<{ ref: unknown; args: Record<string, unknown> }> =
      [];
    const client = {
      action: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
        actionCalls.push({ ref, args });
        if (ref === refs.data.store_git_artifacts.prepareGitObjectUploads) {
          return {
            uploads: [
              {
                sha: objectUpload.sha,
                r2Key: "store/git-objects/aa/object",
                uploadUrl: "https://r2.example/upload-object",
              },
            ],
          };
        }
        if (ref === refs.data.store_git_artifacts.verifyGitObjectUploads) {
          expect(args.objects).toEqual([
            {
              sha: objectUpload.sha,
              type: objectUpload.type,
              sizeBytes: objectUpload.sizeBytes,
            },
          ]);
          return { ok: true };
        }
        if (ref === refs.data.store_git_artifacts.prepareDiffUpload) {
          return {
            uploadUrl: "https://r2.example/upload-diff",
            ref: {
              kind: "r2",
              r2Key: "store/git-diffs/user/large-pack/diff.diff",
              sha256: args.sha256,
              sizeBytes: args.sizeBytes,
            },
          };
        }
        if (ref === refs.data.store_packages.createFirstRelease) {
          expect(args.gitArtifact).toMatchObject({
            kind: "git-object-artifact",
            featureCommit: "b".repeat(40),
          });
          // Diffs are never sent inline — only the R2 ref.
          expect(args.diff).toBeUndefined();
          expect(args.diffRef).toMatchObject({ kind: "r2" });
          return {
            package: packageRecord,
            release: {
              packageId: "large-pack",
              releaseNumber: 1,
              manifest: { category: "customization" },
              blueprintMarkdown: "spec",
              gitArtifact: args.gitArtifact,
              diffRef: args.diffRef,
              createdAt: 2,
            },
          };
        }
        throw new Error(`Unexpected action ${String(ref)}`);
      }),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const operations = createStoreOperations({ convexApi: refs } as never, {
      ensureStoreClient: () => client,
    });

    const release = await operations.createFirstStoreRelease({
      packageId: "large-pack",
      displayName: "Large Pack",
      manifest: {
        packageId: "large-pack",
        releaseNumber: 1,
        category: "customization",
        displayName: "Large Pack",
        createdAt: 1,
      },
      gitObjectUploads: [objectUpload],
      artifact: {
        kind: "blueprint",
        schemaVersion: 2,
        manifest: {
          packageId: "large-pack",
          releaseNumber: 1,
          category: "customization",
          displayName: "Large Pack",
          createdAt: 1,
        },
        blueprintMarkdown: "spec",
        gitArtifact: {
          kind: "git-object-artifact",
          schemaVersion: 1,
          baseCommit: "0".repeat(40),
          featureCommit: "b".repeat(40),
          objects: [
            {
              sha: objectUpload.sha,
              type: objectUpload.type,
              sizeBytes: objectUpload.sizeBytes,
            },
          ],
        },
        diff: "diff --git a/a b/a",
      },
    });

    expect(release.gitArtifact?.featureCommit).toBe("b".repeat(40));
    expect(release.diffRef).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://r2.example/upload-object",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://r2.example/upload-diff",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(actionCalls.map((call) => call.ref)).toEqual([
      refs.data.store_git_artifacts.prepareGitObjectUploads,
      refs.data.store_git_artifacts.verifyGitObjectUploads,
      refs.data.store_git_artifacts.prepareDiffUpload,
      refs.data.store_packages.createFirstRelease,
    ]);
  });

  it("uploads the squashed diff to R2 and sends only the diff ref", async () => {
    const largeDiff = `diff --git a/a b/a\n+${"x".repeat(1_600_000)}`;
    const client = {
      action: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === refs.data.store_git_artifacts.prepareGitObjectUploads) {
          return { uploads: [] };
        }
        if (ref === refs.data.store_git_artifacts.prepareDiffUpload) {
          return {
            uploadUrl: "https://r2.example/upload-diff",
            ref: {
              kind: "r2",
              r2Key: "store/git-diffs/user/large-pack/diff.diff",
              sha256: args.sha256,
              sizeBytes: args.sizeBytes,
            },
          };
        }
        if (ref === refs.data.store_packages.createFirstRelease) {
          expect(args.diff).toBeUndefined();
          expect(args.diffRef).toMatchObject({ kind: "r2" });
          return {
            package: packageRecord,
            release: {
              packageId: "large-pack",
              releaseNumber: 1,
              manifest: { category: "customization" },
              blueprintMarkdown: "spec",
              diffRef: args.diffRef,
              createdAt: 2,
            },
          };
        }
        throw new Error(`Unexpected action ${String(ref)}`);
      }),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const operations = createStoreOperations({ convexApi: refs } as never, {
      ensureStoreClient: () => client,
    });

    const release = await operations.createFirstStoreRelease({
      packageId: "large-pack",
      displayName: "Large Pack",
      manifest: {
        packageId: "large-pack",
        releaseNumber: 1,
        category: "customization",
        displayName: "Large Pack",
        createdAt: 1,
      },
      artifact: {
        kind: "blueprint",
        schemaVersion: 2,
        manifest: {
          packageId: "large-pack",
          releaseNumber: 1,
          category: "customization",
          displayName: "Large Pack",
          createdAt: 1,
        },
        blueprintMarkdown: "spec",
        diff: largeDiff,
      },
    });

    expect(release.diff).toBeUndefined();
    expect(release.diffRef).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://r2.example/upload-diff",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("uploads per-commit diffs as an R2 bundle and sends commit metadata only", async () => {
    let publishedCommits: unknown;
    let publishedCommitsDiffRef: unknown;
    const uploadedBodies: string[] = [];
    const client = {
      action: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
        if (ref === refs.data.store_git_artifacts.prepareGitObjectUploads) {
          return { uploads: [] };
        }
        if (ref === refs.data.store_git_artifacts.prepareDiffUpload) {
          return {
            uploadUrl: `https://r2.example/upload/${String(args.sha256)}`,
            ref: {
              kind: "r2",
              r2Key: `store/git-diffs/user/large-pack/${String(args.sizeBytes)}.diff`,
              sha256: args.sha256,
              sizeBytes: args.sizeBytes,
            },
          };
        }
        if (ref === refs.data.store_packages.createFirstRelease) {
          publishedCommits = args.commits;
          publishedCommitsDiffRef = args.commitsDiffRef;
          return {
            package: packageRecord,
            release: {
              packageId: "large-pack",
              releaseNumber: 1,
              manifest: { category: "customization" },
              blueprintMarkdown: "spec",
              diffRef: args.diffRef,
              commitsDiffRef: args.commitsDiffRef,
              createdAt: 2,
            },
          };
        }
        throw new Error(`Unexpected action ${String(ref)}`);
      }),
    };
    const fetchMock = vi.fn(async (_url: string, init: { body?: unknown }) => {
      if (typeof init?.body !== "undefined") {
        uploadedBodies.push(new TextDecoder().decode(init.body as Uint8Array));
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);

    const operations = createStoreOperations({ convexApi: refs } as never, {
      ensureStoreClient: () => client,
    });

    await operations.createFirstStoreRelease({
      packageId: "large-pack",
      displayName: "Large Pack",
      manifest: {
        packageId: "large-pack",
        releaseNumber: 1,
        category: "customization",
        displayName: "Large Pack",
        createdAt: 1,
      },
      artifact: {
        kind: "blueprint",
        schemaVersion: 2,
        manifest: {
          packageId: "large-pack",
          releaseNumber: 1,
          category: "customization",
          displayName: "Large Pack",
          createdAt: 1,
        },
        blueprintMarkdown: "spec",
        diff: "diff --git a/a b/a",
        commits: [
          { hash: "c".repeat(40), subject: "feat: one", diff: "diff one" },
          { hash: "d".repeat(40), subject: "feat: two", diff: "diff two" },
        ],
      },
    });

    // Commit metadata is sent inline; diffs are stripped.
    expect(publishedCommits).toEqual([
      { hash: "c".repeat(40), subject: "feat: one" },
      { hash: "d".repeat(40), subject: "feat: two" },
    ]);
    expect(publishedCommitsDiffRef).toMatchObject({ kind: "r2" });
    // The per-commit diffs were uploaded as a single JSON bundle.
    const bundleBody = uploadedBodies.find((body) => body.includes("\"commits\""));
    expect(bundleBody).toBeTruthy();
    expect(JSON.parse(bundleBody!)).toEqual({
      version: 1,
      commits: [
        { hash: "c".repeat(40), subject: "feat: one", diff: "diff one" },
        { hash: "d".repeat(40), subject: "feat: two", diff: "diff two" },
      ],
    });
  });

  it("hydrates R2 diff and commit refs when fetching a release for install", async () => {
    const client = {
      query: vi.fn(async (ref: unknown) => {
        if (ref === refs.data.store_packages.getPublicPackage) {
          return packageRecord;
        }
        if (ref === refs.data.store_packages.getPublicRelease) {
          return {
            packageId: "large-pack",
            releaseNumber: 1,
            manifest: { category: "customization" },
            blueprintMarkdown: "spec",
            commits: [{ hash: "c".repeat(40), subject: "feat: one" }],
            commitsDiffRef: {
              kind: "r2",
              r2Key: "store/git-diffs/user/large-pack/commits.diff",
              sha256: "sha256:0".padEnd(71, "0"),
              sizeBytes: 100,
            },
            diffRef: {
              kind: "r2",
              r2Key: "store/git-diffs/user/large-pack/diff.diff",
              sha256: "sha256:0".padEnd(71, "0"),
              sizeBytes: 700_000,
            },
            createdAt: 2,
          };
        }
        throw new Error(`Unexpected query ${String(ref)}`);
      }),
      action: vi.fn(async (ref: unknown) => {
        if (ref === refs.data.store_git_artifacts.getReleaseDiff) {
          return "diff --git a/file.ts b/file.ts\n+ok();";
        }
        if (ref === refs.data.store_git_artifacts.getReleaseCommits) {
          return [{ hash: "c".repeat(40), subject: "feat: one", diff: "diff one" }];
        }
        throw new Error(`Unexpected action ${String(ref)}`);
      }),
    };
    const operations = createStoreOperations({ convexApi: refs } as never, {
      ensureStoreClient: () => client,
    });

    const release = await operations.getStorePackageRelease("large-pack", 1);

    expect(release?.diff).toBe("diff --git a/file.ts b/file.ts\n+ok();");
    expect(release?.commits).toEqual([
      { hash: "c".repeat(40), subject: "feat: one", diff: "diff one" },
    ]);
    expect(client.action).toHaveBeenCalledWith(
      refs.data.store_git_artifacts.getReleaseDiff,
      { packageId: "large-pack", releaseNumber: 1 },
    );
    expect(client.action).toHaveBeenCalledWith(
      refs.data.store_git_artifacts.getReleaseCommits,
      { packageId: "large-pack", releaseNumber: 1 },
    );
  });
});

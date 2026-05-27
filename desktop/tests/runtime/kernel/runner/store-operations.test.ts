import { afterEach, describe, expect, it, vi } from "vitest";
import { createStoreOperations } from "../../../../../runtime/kernel/runner/store-operations.js";
import type {
  StorePackageRecord,
  StoreReleaseSourcePack,
} from "../../../../../runtime/contracts/index.js";

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
    store_source_packs: {
      prepareSourcePackUpload: "prepareSourcePackUpload",
      getReleaseSourcePack: "getReleaseSourcePack",
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

const makeSourcePack = (content: string): StoreReleaseSourcePack => ({
  kind: "stella-source-pack",
  schemaVersion: 1,
  baseRevisionId: "base",
  revisionId: "next",
  changeSets: [
    {
      schemaVersion: 1,
      baseRevisionId: "base",
      parentRevisionIds: ["base"],
      revisionId: "next",
      changes: [
        {
          path: "src/large.ts",
          baseHash: null,
          nextHash: "sha256:next",
          next: { kind: "text", content },
        },
      ],
    },
  ],
});

describe("Store runner source-pack publishing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads large source packs to R2 and publishes only the reference", async () => {
    const largePack = makeSourcePack("x".repeat(700_000));
    const actionCalls: Array<{ ref: unknown; args: Record<string, unknown> }> =
      [];
    const client = {
      action: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
        actionCalls.push({ ref, args });
        if (ref === refs.data.store_source_packs.prepareSourcePackUpload) {
          return {
            uploadUrl: "https://r2.example/upload",
            ref: {
              kind: "r2",
              r2Key: "store/source-packs/user/large-pack/pack.json",
              sha256: args.sha256,
              sizeBytes: args.sizeBytes,
            },
          };
        }
        if (ref === refs.data.store_packages.createFirstRelease) {
          expect(args.sourcePack).toBeUndefined();
          expect(args.sourcePackRef).toMatchObject({
            kind: "r2",
            r2Key: "store/source-packs/user/large-pack/pack.json",
          });
          expect(args.artifactRefs).toBeUndefined();
          return {
            package: packageRecord,
            release: {
              packageId: "large-pack",
              releaseNumber: 1,
              manifest: { category: "customization" },
              blueprintMarkdown: "spec",
              sourcePackRef: args.sourcePackRef,
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
        sourcePack: largePack,
      },
    });

    expect(release.sourcePack).toBeUndefined();
    expect(release.sourcePackRef).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://r2.example/upload",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(actionCalls.map((call) => call.ref)).toEqual([
      refs.data.store_source_packs.prepareSourcePackUpload,
      refs.data.store_packages.createFirstRelease,
    ]);
  });

  it("fails publish when the source pack is too large to upload", async () => {
    const oversizedPack = makeSourcePack("x".repeat(11 * 1024 * 1024));
    const client = {
      action: vi.fn(),
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const operations = createStoreOperations({ convexApi: refs } as never, {
      ensureStoreClient: () => client,
    });

    await expect(
      operations.createFirstStoreRelease({
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
          sourcePack: oversizedPack,
        },
      }),
    ).rejects.toThrow("too large to publish safely");
    expect(client.action).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hydrates R2 source-pack refs when fetching a release for install", async () => {
    const sourcePack = makeSourcePack("small");
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
            sourcePackRef: {
              kind: "r2",
              r2Key: "store/source-packs/user/large-pack/pack.json",
              sha256: "sha256:0".padEnd(71, "0"),
              sizeBytes: 700_000,
            },
            createdAt: 2,
          };
        }
        throw new Error(`Unexpected query ${String(ref)}`);
      }),
      action: vi.fn(async (ref: unknown) => {
        if (ref === refs.data.store_source_packs.getReleaseSourcePack) {
          return sourcePack;
        }
        throw new Error(`Unexpected action ${String(ref)}`);
      }),
    };
    const operations = createStoreOperations({ convexApi: refs } as never, {
      ensureStoreClient: () => client,
    });

    const release = await operations.getStorePackageRelease("large-pack", 1);

    expect(release?.sourcePack).toEqual(sourcePack);
    expect(client.action).toHaveBeenCalledWith(
      refs.data.store_source_packs.getReleaseSourcePack,
      {
        packageId: "large-pack",
        releaseNumber: 1,
      },
    );
  });
});

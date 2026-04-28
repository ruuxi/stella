import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseArtifact,
  StoreReleaseManifest,
} from "../../contracts/index.js";
import type { StorePublishArgs } from "../../protocol/index.js";
import type { RunnerContext, StoreOperations } from "./types.js";

export const createStoreOperations = (
  context: RunnerContext,
  deps: {
    ensureStoreClient: () => any;
  },
): StoreOperations => {
  const toSharedStorePackage = (value: unknown): StorePackageRecord | null => {
    if (!value || typeof value !== "object") {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.packageId !== "string" ||
      typeof record.displayName !== "string" ||
      typeof record.description !== "string" ||
      typeof record.latestReleaseNumber !== "number" ||
      typeof record.createdAt !== "number" ||
      typeof record.updatedAt !== "number"
    ) {
      return null;
    }
    return {
      packageId: record.packageId,
      ...(record.category === "agents" || record.category === "stella"
        ? { category: record.category }
        : {}),
      displayName: record.displayName,
      description: record.description,
      latestReleaseNumber: record.latestReleaseNumber,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  };

  const toSharedStoreRelease = (args: {
    release: unknown;
    packageRecord: StorePackageRecord;
  }): StorePackageReleaseRecord | null => {
    if (!args.release || typeof args.release !== "object") {
      return null;
    }
    const record = args.release as Record<string, unknown>;
    const manifest =
      record.manifest && typeof record.manifest === "object"
        ? (record.manifest as Record<string, unknown>)
        : null;
    if (
      !manifest ||
      typeof record.packageId !== "string" ||
      typeof record.releaseNumber !== "number" ||
      typeof record.createdAt !== "number" ||
      typeof record.artifactStorageKey !== "string" ||
      !Array.isArray(manifest.includedBatchIds) ||
      !Array.isArray(manifest.includedCommitHashes) ||
      !Array.isArray(manifest.changedFiles)
    ) {
      return null;
    }
    return {
      packageId: record.packageId,
      releaseNumber: record.releaseNumber,
      manifest: {
        packageId: record.packageId,
        releaseNumber: record.releaseNumber,
        category:
          manifest.category === "agents" || manifest.category === "stella"
            ? manifest.category
            : "stella",
        displayName: args.packageRecord.displayName,
        description: args.packageRecord.description,
        ...(typeof record.releaseNotes === "string"
          ? { releaseNotes: record.releaseNotes }
          : {}),
        batchIds: manifest.includedBatchIds.filter(
          (value): value is string => typeof value === "string",
        ),
        commitHashes: manifest.includedCommitHashes.filter(
          (value): value is string => typeof value === "string",
        ),
        files: manifest.changedFiles.filter(
          (value): value is string => typeof value === "string",
        ),
        createdAt: record.createdAt,
      },
      storageKey: record.artifactStorageKey,
      ...(record.artifactUrl == null || typeof record.artifactUrl === "string"
        ? { artifactUrl: record.artifactUrl as string | null | undefined }
        : {}),
      createdAt: record.createdAt,
    };
  };

  const toBackendStoreManifest = (manifest: StoreReleaseManifest) => ({
    includedBatchIds: [...manifest.batchIds],
    includedCommitHashes: [...manifest.commitHashes],
    changedFiles: [...manifest.files],
    category: manifest.category,
    ...(manifest.releaseNotes ? { summary: manifest.releaseNotes } : {}),
  });

  const listStorePackages = async (): Promise<StorePackageRecord[]> => {
    const client = deps.ensureStoreClient();
    const records = (await client.query(
      (
        context.convexApi as {
          data: { store_packages: { listPackages: unknown } };
        }
      ).data.store_packages.listPackages,
      {},
    )) as unknown[];
    return records
      .map((record) => toSharedStorePackage(record))
      .filter((record): record is StorePackageRecord => Boolean(record));
  };

  const getStorePackage = async (
    packageId: string,
  ): Promise<StorePackageRecord | null> => {
    const client = deps.ensureStoreClient();
    const record = await client.query(
      (
        context.convexApi as {
          data: { store_packages: { getPackage: unknown } };
        }
      ).data.store_packages.getPackage,
      { packageId },
    );
    return toSharedStorePackage(record);
  };

  const listStorePackageReleases = async (
    packageId: string,
  ): Promise<StorePackageReleaseRecord[]> => {
    const client = deps.ensureStoreClient();
    const packageRecord = await getStorePackage(packageId);
    if (!packageRecord) {
      return [];
    }
    const records = (await client.query(
      (
        context.convexApi as {
          data: { store_packages: { listReleases: unknown } };
        }
      ).data.store_packages.listReleases,
      { packageId },
    )) as unknown[];
    return records
      .map((record) => toSharedStoreRelease({ release: record, packageRecord }))
      .filter((record): record is StorePackageReleaseRecord => Boolean(record));
  };

  const getStorePackageRelease = async (
    packageId: string,
    releaseNumber: number,
  ): Promise<StorePackageReleaseRecord | null> => {
    const client = deps.ensureStoreClient();
    const packageRecord = await getStorePackage(packageId);
    if (!packageRecord) {
      return null;
    }
    const record = await client.query(
      (
        context.convexApi as {
          data: { store_packages: { getRelease: unknown } };
        }
      ).data.store_packages.getRelease,
      { packageId, releaseNumber },
    );
    return toSharedStoreRelease({ release: record, packageRecord });
  };

  const createFirstStoreRelease = async (
    args: StorePublishArgs,
  ): Promise<StorePackageReleaseRecord> => {
    const client = deps.ensureStoreClient();
    const result = (await client.action(
      (
        context.convexApi as {
          data: { store_packages: { createFirstRelease: unknown } };
        }
      ).data.store_packages.createFirstRelease,
      {
        packageId: args.packageId,
        category: args.manifest.category,
        displayName: args.displayName,
        description: args.description,
        releaseNotes: args.releaseNotes,
        manifest: toBackendStoreManifest(args.manifest),
        artifactBody: JSON.stringify(args.artifact),
        artifactContentType: "application/json",
      },
    )) as {
      package?: unknown;
      release?: unknown;
    };
    const packageRecord = toSharedStorePackage(result.package);
    const releaseRecord = packageRecord
      ? toSharedStoreRelease({ release: result.release, packageRecord })
      : null;
    if (!releaseRecord) {
      throw new Error("Store publish returned an invalid release payload.");
    }
    return releaseRecord;
  };

  const createStoreReleaseUpdate = async (
    args: StorePublishArgs,
  ): Promise<StorePackageReleaseRecord> => {
    const client = deps.ensureStoreClient();
    const result = (await client.action(
      (
        context.convexApi as {
          data: { store_packages: { createUpdateRelease: unknown } };
        }
      ).data.store_packages.createUpdateRelease,
      {
        packageId: args.packageId,
        releaseNotes: args.releaseNotes,
        manifest: toBackendStoreManifest(args.manifest),
        artifactBody: JSON.stringify(args.artifact),
        artifactContentType: "application/json",
      },
    )) as {
      package?: unknown;
      release?: unknown;
    };
    const packageRecord = toSharedStorePackage(result.package);
    const releaseRecord = packageRecord
      ? toSharedStoreRelease({ release: result.release, packageRecord })
      : null;
    if (!releaseRecord) {
      throw new Error("Store publish returned an invalid release payload.");
    }
    return releaseRecord;
  };

  const publishStoreCandidateRelease: StoreOperations["publishStoreCandidateRelease"] =
    async (args) => {
      const client = deps.ensureStoreClient();
      const result = (await client.action(
        (
          context.convexApi as {
            data: { store_publish_agent: { publishCandidateRelease: unknown } };
          }
        ).data.store_publish_agent.publishCandidateRelease,
        args,
      )) as {
        package?: unknown;
        release?: unknown;
      } | unknown;

      const releaseResult = result as { package?: unknown; release?: unknown };
      const packageRecord = toSharedStorePackage(releaseResult.package);
      const releaseRecord = packageRecord
        ? toSharedStoreRelease({ release: releaseResult.release, packageRecord })
        : null;
      if (!releaseRecord) {
        throw new Error("Store publish returned an invalid release payload.");
      }
      return releaseRecord;
    };

  const prepareStoreCandidateRelease: StoreOperations["prepareStoreCandidateRelease"] =
    async (args) => {
      const client = deps.ensureStoreClient();
      return (await client.action(
        (
          context.convexApi as {
            data: { store_publish_agent: { prepareCandidateRelease: unknown } };
          }
        ).data.store_publish_agent.prepareCandidateRelease,
        args,
      )) as Awaited<ReturnType<StoreOperations["prepareStoreCandidateRelease"]>>;
    };

  const publishPreparedStoreRelease: StoreOperations["publishPreparedStoreRelease"] =
    async (args) => {
      const client = deps.ensureStoreClient();
      const result = (await client.action(
        (
          context.convexApi as {
            data: { store_publish_agent: { publishPreparedRelease: unknown } };
          }
        ).data.store_publish_agent.publishPreparedRelease,
        args,
      )) as {
        package?: unknown;
        release?: unknown;
      } | unknown;

      const releaseResult = result as { package?: unknown; release?: unknown };
      const packageRecord = toSharedStorePackage(releaseResult.package);
      const releaseRecord = packageRecord
        ? toSharedStoreRelease({ release: releaseResult.release, packageRecord })
        : null;
      if (!releaseRecord) {
        throw new Error("Store publish returned an invalid release payload.");
      }
      return releaseRecord;
    };

  return {
    listStorePackages,
    getStorePackage,
    listStorePackageReleases,
    getStorePackageRelease,
    createFirstStoreRelease,
    createStoreReleaseUpdate,
    publishStoreCandidateRelease,
    prepareStoreCandidateRelease,
    publishPreparedStoreRelease,
  };
};

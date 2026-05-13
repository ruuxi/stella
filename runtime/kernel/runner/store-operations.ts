import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseCommit,
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
      typeof record.latestReleaseNumber !== "number" ||
      typeof record.createdAt !== "number" ||
      typeof record.updatedAt !== "number"
    ) {
      return null;
    }
    const validCategories = new Set([
      "apps-games",
      "productivity",
      "customization",
      "skills-agents",
      "integrations",
      "other",
    ]);
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return {
      packageId: record.packageId,
      ...(typeof record.category === "string"
      && validCategories.has(record.category)
        ? { category: record.category as StorePackageRecord["category"] }
        : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      displayName: record.displayName,
      ...(typeof record.description === "string" && record.description
        ? { description: record.description }
        : {}),
      latestReleaseNumber: record.latestReleaseNumber,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(typeof record.iconUrl === "string" && record.iconUrl
        ? { iconUrl: record.iconUrl }
        : {}),
      ...(typeof record.authorUsername === "string" && record.authorUsername
        ? { authorUsername: record.authorUsername }
        : {}),
      ...(record.featured === true ? { featured: true } : {}),
      ...(record.visibility === "public"
        || record.visibility === "unlisted"
        || record.visibility === "private"
        ? { visibility: record.visibility }
        : {}),
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
      typeof record.blueprintMarkdown !== "string"
    ) {
      return null;
    }
    const parsedCommits: StoreReleaseCommit[] = Array.isArray(record.commits)
      ? record.commits
          .map((entry: unknown): StoreReleaseCommit | null => {
            if (!entry || typeof entry !== "object") return null;
            const commitRecord = entry as Record<string, unknown>;
            if (
              typeof commitRecord.hash !== "string" ||
              typeof commitRecord.subject !== "string" ||
              typeof commitRecord.diff !== "string"
            ) {
              return null;
            }
            return {
              hash: commitRecord.hash,
              subject: commitRecord.subject,
              diff: commitRecord.diff,
            };
          })
          .filter((entry: StoreReleaseCommit | null): entry is StoreReleaseCommit => entry !== null)
      : [];
    const validManifestCategories = new Set([
      "apps-games",
      "productivity",
      "customization",
      "skills-agents",
      "integrations",
      "other",
    ]);
    return {
      packageId: record.packageId,
      releaseNumber: record.releaseNumber,
      manifest: {
        packageId: record.packageId,
        releaseNumber: record.releaseNumber,
        category:
          typeof manifest.category === "string"
          && validManifestCategories.has(manifest.category)
            ? (manifest.category as StorePackageRecord["category"] & string)
            : "other",
        displayName: args.packageRecord.displayName,
        ...(args.packageRecord.description
          ? { description: args.packageRecord.description }
          : {}),
        ...(typeof record.releaseNotes === "string"
          ? { releaseNotes: record.releaseNotes }
          : {}),
        createdAt: record.createdAt,
        ...(typeof manifest.authoredAtCommit === "string" && manifest.authoredAtCommit
          ? { authoredAtCommit: manifest.authoredAtCommit }
          : {}),
        ...(typeof manifest.iconUrl === "string" && manifest.iconUrl
          ? { iconUrl: manifest.iconUrl }
          : args.packageRecord.iconUrl
            ? { iconUrl: args.packageRecord.iconUrl }
            : {}),
      },
      blueprintMarkdown: record.blueprintMarkdown,
      ...(parsedCommits.length > 0 ? { commits: parsedCommits } : {}),
      createdAt: record.createdAt,
    };
  };

  const toBackendStoreManifest = (manifest: StoreReleaseManifest) => ({
    category: manifest.category,
    ...(manifest.releaseNotes ? { summary: manifest.releaseNotes } : {}),
    ...(manifest.authoredAtCommit
      ? { authoredAtCommit: manifest.authoredAtCommit }
      : {}),
    ...(manifest.iconUrl ? { iconUrl: manifest.iconUrl } : {}),
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

  // The runner's package + release readers go through the *public*
  // queries because the install pipeline must be able to fetch any
  // creator's add-on, not just the current user's. The owner-filtered
  // `listPackages` query still feeds "your add-ons" surfaces directly
  // from the renderer.
  const getStorePackage = async (
    packageId: string,
  ): Promise<StorePackageRecord | null> => {
    const client = deps.ensureStoreClient();
    const record = await client.query(
      (
        context.convexApi as {
          data: { store_packages: { getPublicPackage: unknown } };
        }
      ).data.store_packages.getPublicPackage,
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
          data: { store_packages: { listPublicReleases: unknown } };
        }
      ).data.store_packages.listPublicReleases,
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
          data: { store_packages: { getPublicRelease: unknown } };
        }
      ).data.store_packages.getPublicRelease,
      { packageId, releaseNumber },
    );
    return toSharedStoreRelease({ release: record, packageRecord });
  };

  const createFirstStoreRelease = async (
    args: StorePublishArgs,
  ): Promise<StorePackageReleaseRecord> => {
    const client = deps.ensureStoreClient();
    const commits = args.artifact.commits ?? [];
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
        ...(args.description ? { description: args.description } : {}),
        releaseNotes: args.releaseNotes,
        manifest: toBackendStoreManifest(args.manifest),
        blueprintMarkdown: args.artifact.blueprintMarkdown,
        ...(commits.length > 0 ? { commits } : {}),
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
    const commits = args.artifact.commits ?? [];
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
        blueprintMarkdown: args.artifact.blueprintMarkdown,
        ...(commits.length > 0 ? { commits } : {}),
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

  return {
    listStorePackages,
    getStorePackage,
    listStorePackageReleases,
    getStorePackageRelease,
    createFirstStoreRelease,
    createStoreReleaseUpdate,
  };
};

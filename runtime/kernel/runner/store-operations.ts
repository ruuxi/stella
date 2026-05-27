import { createHash } from "node:crypto";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseCommit,
  StoreReleaseManifest,
  StoreReleaseSourcePack,
  StoreReleaseSourcePackRef,
} from "../../contracts/index.js";
import type { StorePublishArgs } from "../../protocol/index.js";
import type { RunnerContext, StoreOperations } from "./types.js";

export const createStoreOperations = (
  context: RunnerContext,
  deps: {
    ensureStoreClient: () => any;
  },
): StoreOperations => {
  const SOURCE_PACK_INLINE_BYTES = 650_000;
  const SOURCE_PACK_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
      ? record.tags.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : undefined;
    return {
      packageId: record.packageId,
      ...(typeof record.category === "string" &&
      validCategories.has(record.category)
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
      ...(record.visibility === "public" ||
      record.visibility === "unlisted" ||
      record.visibility === "private"
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
          .filter(
            (entry: StoreReleaseCommit | null): entry is StoreReleaseCommit =>
              entry !== null,
          )
      : [];
    const sourcePack =
      record.sourcePack &&
      typeof record.sourcePack === "object" &&
      (record.sourcePack as Record<string, unknown>).kind ===
        "stella-source-pack" &&
      (record.sourcePack as Record<string, unknown>).schemaVersion === 1
        ? (record.sourcePack as StoreReleaseSourcePack)
        : undefined;
    const sourcePackRefRecord =
      record.sourcePackRef && typeof record.sourcePackRef === "object"
        ? (record.sourcePackRef as Record<string, unknown>)
        : null;
    const sourcePackRef =
      sourcePackRefRecord?.kind === "r2" &&
      typeof sourcePackRefRecord.r2Key === "string" &&
      typeof sourcePackRefRecord.sha256 === "string" &&
      typeof sourcePackRefRecord.sizeBytes === "number"
        ? (sourcePackRefRecord as StoreReleaseSourcePackRef)
        : undefined;
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
          typeof manifest.category === "string" &&
          validManifestCategories.has(manifest.category)
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
        ...(typeof manifest.authoredAtCommit === "string" &&
        manifest.authoredAtCommit
          ? { authoredAtCommit: manifest.authoredAtCommit }
          : {}),
        ...(typeof manifest.iconUrl === "string" && manifest.iconUrl
          ? { iconUrl: manifest.iconUrl }
          : args.packageRecord.iconUrl
            ? { iconUrl: args.packageRecord.iconUrl }
            : {}),
      },
      blueprintMarkdown: record.blueprintMarkdown,
      ...(sourcePack ? { sourcePack } : {}),
      ...(sourcePackRef ? { sourcePackRef } : {}),
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

  const serializeSourcePack = (
    sourcePack: StoreReleaseSourcePack,
  ): Uint8Array => new TextEncoder().encode(JSON.stringify(sourcePack));

  const hashBytes = (bytes: Uint8Array): string =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  const uploadLargeSourcePack = async (args: {
    client: any;
    packageId: string;
    sourcePack: StoreReleaseSourcePack;
  }): Promise<{
    sourcePack?: StoreReleaseSourcePack;
    sourcePackRef?: StoreReleaseSourcePackRef;
  }> => {
    const bytes = serializeSourcePack(args.sourcePack);
    if (bytes.byteLength <= SOURCE_PACK_INLINE_BYTES) {
      return { sourcePack: args.sourcePack };
    }
    if (bytes.byteLength > SOURCE_PACK_MAX_UPLOAD_BYTES) {
      throw new Error(
        "Store source pack is too large to publish safely. Reduce the selected feature scope and try again.",
      );
    }
    const prepared = (await args.client.action(
      (
        context.convexApi as {
          data: {
            store_source_packs: { prepareSourcePackUpload: unknown };
          };
        }
      ).data.store_source_packs.prepareSourcePackUpload,
      {
        packageId: args.packageId,
        sha256: hashBytes(bytes),
        sizeBytes: bytes.byteLength,
      },
    )) as { ref?: unknown; uploadUrl?: unknown };
    const ref =
      prepared.ref &&
      typeof prepared.ref === "object" &&
      (prepared.ref as Record<string, unknown>).kind === "r2"
        ? (prepared.ref as StoreReleaseSourcePackRef)
        : null;
    if (!ref || typeof prepared.uploadUrl !== "string") {
      throw new Error("Store source-pack upload preparation failed.");
    }
    const response = await fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: bytes,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Store source-pack upload failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return { sourcePackRef: ref };
  };

  const hydrateReleaseSourcePack = async (
    client: any,
    release: StorePackageReleaseRecord | null,
  ): Promise<StorePackageReleaseRecord | null> => {
    if (!release || release.sourcePack || !release.sourcePackRef) {
      return release;
    }
    const sourcePack = (await client.action(
      (
        context.convexApi as {
          data: {
            store_source_packs: { getReleaseSourcePack: unknown };
          };
        }
      ).data.store_source_packs.getReleaseSourcePack,
      {
        packageId: release.packageId,
        releaseNumber: release.releaseNumber,
      },
    )) as StoreReleaseSourcePack | null;
    return sourcePack ? { ...release, sourcePack } : release;
  };

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
    return await hydrateReleaseSourcePack(
      client,
      toSharedStoreRelease({ release: record, packageRecord }),
    );
  };

  const createFirstStoreRelease = async (
    args: StorePublishArgs,
  ): Promise<StorePackageReleaseRecord> => {
    const client = deps.ensureStoreClient();
    const commits = args.artifact.commits ?? [];
    const sourcePackStorage = args.artifact.sourcePack
      ? await uploadLargeSourcePack({
          client,
          packageId: args.packageId,
          sourcePack: args.artifact.sourcePack,
        })
      : {};
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
        ...sourcePackStorage,
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
    const sourcePackStorage = args.artifact.sourcePack
      ? await uploadLargeSourcePack({
          client,
          packageId: args.packageId,
          sourcePack: args.artifact.sourcePack,
        })
      : {};
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
        ...sourcePackStorage,
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

import { createHash } from "node:crypto";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
  StoreReleaseCommit,
  StoreReleaseDiffRef,
  StoreReleaseGitArtifact,
  StoreReleaseGitObjectUpload,
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
  const RELEASE_DIFF_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

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
    const gitArtifact =
      record.gitArtifact &&
      typeof record.gitArtifact === "object" &&
      (record.gitArtifact as Record<string, unknown>).kind ===
        "git-object-artifact" &&
      (record.gitArtifact as Record<string, unknown>).schemaVersion === 1
        ? (record.gitArtifact as StoreReleaseGitArtifact)
        : undefined;
    const diffRefRecord =
      record.diffRef && typeof record.diffRef === "object"
        ? (record.diffRef as Record<string, unknown>)
        : null;
    const diffRef =
      diffRefRecord?.kind === "r2" &&
      typeof diffRefRecord.r2Key === "string" &&
      typeof diffRefRecord.sha256 === "string" &&
      typeof diffRefRecord.sizeBytes === "number"
        ? (diffRefRecord as StoreReleaseDiffRef)
        : undefined;
    const commitsDiffRefRecord =
      record.commitsDiffRef && typeof record.commitsDiffRef === "object"
        ? (record.commitsDiffRef as Record<string, unknown>)
        : null;
    const commitsDiffRef =
      commitsDiffRefRecord?.kind === "r2" &&
      typeof commitsDiffRefRecord.r2Key === "string" &&
      typeof commitsDiffRefRecord.sha256 === "string" &&
      typeof commitsDiffRefRecord.sizeBytes === "number"
        ? (commitsDiffRefRecord as StoreReleaseDiffRef)
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
      ...(gitArtifact ? { gitArtifact } : {}),
      ...(diffRef ? { diffRef } : {}),
      ...(commitsDiffRef ? { commitsDiffRef } : {}),
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

  const hashBytes = (bytes: Uint8Array): string =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  const uploadGitObjects = async (args: {
    client: any;
    objects: StoreReleaseGitObjectUpload[];
  }): Promise<void> => {
    if (args.objects.length === 0) return;
    const prepared = (await args.client.action(
      (
        context.convexApi as {
          data: {
            store_git_artifacts: { prepareGitObjectUploads: unknown };
          };
        }
      ).data.store_git_artifacts.prepareGitObjectUploads,
      {
        objects: args.objects.map(({ sha, type, sizeBytes }) => ({
          sha,
          type,
          sizeBytes,
        })),
      },
    )) as { uploads?: unknown };
    const uploads = Array.isArray(prepared.uploads)
      ? prepared.uploads
          .map((entry): { sha: string; uploadUrl: string } | null => {
            if (!entry || typeof entry !== "object") return null;
            const record = entry as Record<string, unknown>;
            if (
              typeof record.sha !== "string" ||
              typeof record.uploadUrl !== "string"
            ) {
              return null;
            }
            return { sha: record.sha, uploadUrl: record.uploadUrl };
          })
          .filter(
            (entry): entry is { sha: string; uploadUrl: string } =>
              entry !== null,
          )
      : [];
    const bySha = new Map(args.objects.map((object) => [object.sha, object]));
    const uploadedObjects: StoreReleaseGitObjectUpload[] = [];
    for (const upload of uploads) {
      const object = bySha.get(upload.sha);
      if (!object) continue;
      const response = await fetch(upload.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/x-git-object",
        },
        body: object.compressedBytes,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `Store Git object upload failed (${response.status})${detail ? `: ${detail}` : ""}`,
        );
      }
      uploadedObjects.push(object);
    }
    if (uploadedObjects.length > 0) {
      await args.client.action(
        (
          context.convexApi as {
            data: {
              store_git_artifacts: { verifyGitObjectUploads: unknown };
            };
          }
        ).data.store_git_artifacts.verifyGitObjectUploads,
        {
          objects: uploadedObjects.map(({ sha, type, sizeBytes }) => ({
            sha,
            type,
            sizeBytes,
          })),
        },
      );
    }
  };

  // Squashed diffs and the per-commit diff bundle are always stored in R2 —
  // never inline on the release document — so release docs stay small and
  // list/detail subscriptions stay cheap. Both go through this single
  // presigned-upload path.
  const uploadDiffBytes = async (args: {
    client: any;
    packageId: string;
    bytes: Uint8Array;
  }): Promise<StoreReleaseDiffRef> => {
    if (args.bytes.byteLength > RELEASE_DIFF_MAX_UPLOAD_BYTES) {
      throw new Error(
        "Store feature diff is too large to publish safely. Reduce the selected feature scope and try again.",
      );
    }
    const prepared = (await args.client.action(
      (
        context.convexApi as {
          data: {
            store_git_artifacts: { prepareDiffUpload: unknown };
          };
        }
      ).data.store_git_artifacts.prepareDiffUpload,
      {
        packageId: args.packageId,
        sha256: hashBytes(args.bytes),
        sizeBytes: args.bytes.byteLength,
      },
    )) as { ref?: unknown; uploadUrl?: unknown };
    const ref =
      prepared.ref &&
      typeof prepared.ref === "object" &&
      (prepared.ref as Record<string, unknown>).kind === "r2"
        ? (prepared.ref as StoreReleaseDiffRef)
        : null;
    if (!ref || typeof prepared.uploadUrl !== "string") {
      throw new Error("Store diff upload preparation failed.");
    }
    const response = await fetch(prepared.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "text/x-diff; charset=utf-8",
      },
      body: args.bytes,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Store diff upload failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return ref;
  };

  const uploadDiff = async (args: {
    client: any;
    packageId: string;
    diff: string;
  }): Promise<StoreReleaseDiffRef> =>
    await uploadDiffBytes({
      client: args.client,
      packageId: args.packageId,
      bytes: new TextEncoder().encode(args.diff),
    });

  // Per-commit reference diffs are serialized into a single JSON bundle and
  // uploaded as one R2 object. Hydrated back via `getReleaseCommits`.
  const uploadCommitsBundle = async (args: {
    client: any;
    packageId: string;
    commits: StoreReleaseCommit[];
  }): Promise<StoreReleaseDiffRef> =>
    await uploadDiffBytes({
      client: args.client,
      packageId: args.packageId,
      bytes: new TextEncoder().encode(
        JSON.stringify({ version: 1, commits: args.commits }),
      ),
    });

  const hydrateReleaseDiff = async (
    client: any,
    release: StorePackageReleaseRecord | null,
  ): Promise<StorePackageReleaseRecord | null> => {
    if (!release || release.diff || !release.diffRef) {
      return release;
    }
    const diff = (await client.action(
      (
        context.convexApi as {
          data: {
            store_git_artifacts: { getReleaseDiff: unknown };
          };
        }
      ).data.store_git_artifacts.getReleaseDiff,
      {
        packageId: release.packageId,
        releaseNumber: release.releaseNumber,
      },
    )) as string | null;
    return diff ? { ...release, diff } : release;
  };

  const hydrateReleaseCommits = async (
    client: any,
    release: StorePackageReleaseRecord | null,
  ): Promise<StorePackageReleaseRecord | null> => {
    if (
      !release ||
      (release.commits && release.commits.length > 0) ||
      !release.commitsDiffRef
    ) {
      return release;
    }
    const raw = (await client.action(
      (
        context.convexApi as {
          data: {
            store_git_artifacts: { getReleaseCommits: unknown };
          };
        }
      ).data.store_git_artifacts.getReleaseCommits,
      {
        packageId: release.packageId,
        releaseNumber: release.releaseNumber,
      },
    )) as unknown;
    const commits = Array.isArray(raw)
      ? raw
          .map((entry): StoreReleaseCommit | null => {
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
            (entry): entry is StoreReleaseCommit => entry !== null,
          )
      : [];
    return commits.length > 0 ? { ...release, commits } : release;
  };

  const hydrateReleaseArtifact = async (
    client: any,
    release: StorePackageReleaseRecord | null,
  ): Promise<StorePackageReleaseRecord | null> =>
    await hydrateReleaseCommits(
      client,
      await hydrateReleaseDiff(client, release),
    );

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
    return await hydrateReleaseArtifact(
      client,
      toSharedStoreRelease({ release: record, packageRecord }),
    );
  };

  const createFirstStoreRelease = async (
    args: StorePublishArgs,
  ): Promise<StorePackageReleaseRecord> => {
    const client = deps.ensureStoreClient();
    const commits = args.artifact.commits ?? [];
    await uploadGitObjects({
      client,
      objects: args.gitObjectUploads ?? [],
    });
    const diffRef = args.artifact.diff
      ? await uploadDiff({
          client,
          packageId: args.packageId,
          diff: args.artifact.diff,
        })
      : undefined;
    const commitsDiffRef =
      commits.length > 0
        ? await uploadCommitsBundle({
            client,
            packageId: args.packageId,
            commits,
          })
        : undefined;
    const commitsMeta = commits.map(({ hash, subject }) => ({ hash, subject }));
    const result = (await client.action(
      (
        context.convexApi as {
          data: { store_packages: { createFirstRelease: unknown } };
        }
      ).data.store_packages.createFirstRelease,
      {
        packageId: args.packageId,
        ...(args.audience ? { audience: args.audience } : {}),
        category: args.manifest.category,
        displayName: args.displayName,
        ...(args.description ? { description: args.description } : {}),
        releaseNotes: args.releaseNotes,
        manifest: toBackendStoreManifest(args.manifest),
        blueprintMarkdown: args.artifact.blueprintMarkdown,
        ...(args.artifact.gitArtifact
          ? { gitArtifact: args.artifact.gitArtifact }
          : {}),
        ...(diffRef ? { diffRef } : {}),
        ...(commitsDiffRef ? { commitsDiffRef } : {}),
        ...(commitsMeta.length > 0 ? { commits: commitsMeta } : {}),
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
    await uploadGitObjects({
      client,
      objects: args.gitObjectUploads ?? [],
    });
    const diffRef = args.artifact.diff
      ? await uploadDiff({
          client,
          packageId: args.packageId,
          diff: args.artifact.diff,
        })
      : undefined;
    const commitsDiffRef =
      commits.length > 0
        ? await uploadCommitsBundle({
            client,
            packageId: args.packageId,
            commits,
          })
        : undefined;
    const commitsMeta = commits.map(({ hash, subject }) => ({ hash, subject }));
    const result = (await client.action(
      (
        context.convexApi as {
          data: { store_packages: { createUpdateRelease: unknown } };
        }
      ).data.store_packages.createUpdateRelease,
      {
        packageId: args.packageId,
        ...(args.audience ? { audience: args.audience } : {}),
        releaseNotes: args.releaseNotes,
        manifest: toBackendStoreManifest(args.manifest),
        blueprintMarkdown: args.artifact.blueprintMarkdown,
        ...(args.artifact.gitArtifact
          ? { gitArtifact: args.artifact.gitArtifact }
          : {}),
        ...(diffRef ? { diffRef } : {}),
        ...(commitsDiffRef ? { commitsDiffRef } : {}),
        ...(commitsMeta.length > 0 ? { commits: commitsMeta } : {}),
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

  const getStoreGitObjectUrls = async (
    packageId: string,
    releaseNumber: number,
    shas: string[],
  ): Promise<Array<{ sha: string; r2Key: string; downloadUrl: string }>> => {
    if (shas.length === 0) return [];
    const client = deps.ensureStoreClient();
    const records = (await client.action(
      (
        context.convexApi as {
          data: {
            store_git_artifacts: { getReleaseGitObjectUrls: unknown };
          };
        }
      ).data.store_git_artifacts.getReleaseGitObjectUrls,
      { packageId, releaseNumber, shas },
    )) as unknown[];
    return records
      .map(
        (entry): { sha: string; r2Key: string; downloadUrl: string } | null => {
          if (!entry || typeof entry !== "object") return null;
          const record = entry as Record<string, unknown>;
          if (
            typeof record.sha !== "string" ||
            typeof record.r2Key !== "string" ||
            typeof record.downloadUrl !== "string"
          ) {
            return null;
          }
          return {
            sha: record.sha,
            r2Key: record.r2Key,
            downloadUrl: record.downloadUrl,
          };
        },
      )
      .filter(
        (entry): entry is { sha: string; r2Key: string; downloadUrl: string } =>
          entry !== null,
      );
  };

  return {
    listStorePackages,
    getStorePackage,
    listStorePackageReleases,
    getStorePackageRelease,
    createFirstStoreRelease,
    createStoreReleaseUpdate,
    getStoreGitObjectUrls,
  };
};

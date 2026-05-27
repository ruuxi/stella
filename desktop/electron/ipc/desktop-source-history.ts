import type {
  DesktopReleaseSourceHistoryRef,
  StoreReleaseSourcePack,
} from "../../../runtime/contracts/index.js";

export const DEFAULT_DESKTOP_RELEASES_PUBLIC_BASE_URL =
  "https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/desktop/releases";

type SourceHistoryRunner = {
  recordSourcePackHistory?: (payload: {
    sourcePack: StoreReleaseSourcePack;
    origin: "desktop-update" | "official";
    featureId: string;
    description: string;
    commitHash: string;
  }) => Promise<{ ok: true }>;
};

const DESKTOP_RELEASE_TAG_PATTERN = /^desktop-v[0-9A-Za-z._-]+$/;

export const desktopReleaseManifestUrl = (
  releaseTag: string,
  baseUrl = DEFAULT_DESKTOP_RELEASES_PUBLIC_BASE_URL,
): string => {
  const tag = releaseTag.trim();
  if (!DESKTOP_RELEASE_TAG_PATTERN.test(tag)) {
    throw new Error("Desktop release tag is invalid.");
  }
  return `${baseUrl.replace(/\/$/, "")}/${tag}/manifest.json`;
};

const normalizeSourceHistoryRef = (
  value: unknown,
): DesktopReleaseSourceHistoryRef | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.url !== "string" ||
    typeof record.sha256 !== "string" ||
    typeof record.size !== "number"
  ) {
    return null;
  }
  const url = record.url.trim();
  const sha256 = record.sha256.trim().toLowerCase();
  if (!/^https:\/\//i.test(url)) return null;
  if (!/^sha256:[0-9a-f]{64}$/.test(sha256)) return null;
  if (!Number.isInteger(record.size) || record.size <= 0) return null;
  return {
    kind: "url",
    url,
    sha256,
    sizeBytes: record.size,
  };
};

export const sourceHistoryRefFromDesktopReleaseManifest = (
  value: unknown,
  args?: { targetCommit?: string | null },
): DesktopReleaseSourceHistoryRef | null => {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Record<string, unknown>;
  const targetCommit = args?.targetCommit?.trim();
  if (targetCommit) {
    if (
      typeof manifest.commit !== "string" ||
      manifest.commit.trim() !== targetCommit
    ) {
      return null;
    }
  }
  return normalizeSourceHistoryRef(manifest.sourceHistory);
};

export const desktopSourcePackMatchesBaseCommit = (
  sourcePack: StoreReleaseSourcePack,
  baseCommit: string,
): boolean => sourcePack.baseRevisionId === `git:${baseCommit.trim()}`;

export const desktopSourcePackCanApplyLocally = (
  sourcePack: StoreReleaseSourcePack,
): boolean =>
  sourcePack.changeSets.every((changeSet) =>
    changeSet.changes.every((change) => {
      if (change.baseHash && !change.base) return false;
      if (change.nextHash && !change.next) return false;
      return true;
    }),
  );

export const recordDesktopUpdateSourceHistory = async (
  runner: SourceHistoryRunner | null,
  args: {
    sourcePack: StoreReleaseSourcePack;
    releaseTag: string;
    targetCommit: string;
    origin?: "desktop-update" | "official";
  },
): Promise<void> => {
  if (!runner?.recordSourcePackHistory) return;
  await runner.recordSourcePackHistory({
    sourcePack: args.sourcePack,
    origin: args.origin ?? "desktop-update",
    featureId: args.sourcePack.featureId ?? "desktop-release",
    description:
      args.sourcePack.description ?? `Desktop release ${args.releaseTag}`,
    commitHash: args.targetCommit,
  });
};

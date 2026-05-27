import { describe, expect, it, vi } from "vitest";
import {
  desktopSourcePackCanApplyLocally,
  desktopSourcePackMatchesBaseCommit,
  desktopReleaseManifestUrl,
  recordDesktopUpdateSourceHistory,
  sourceHistoryRefFromDesktopReleaseManifest,
} from "../../../electron/ipc/desktop-source-history.js";
import type { StoreReleaseSourcePack } from "../../../../runtime/contracts/index.js";

const sourcePack: StoreReleaseSourcePack = {
  kind: "stella-source-pack",
  schemaVersion: 1,
  baseRevisionId: "git:base",
  revisionId: "sha256:next",
  featureId: "desktop-release",
  description: "Desktop release desktop-v1",
  changeSets: [
    {
      schemaVersion: 1,
      baseRevisionId: "git:base",
      parentRevisionIds: ["git:base"],
      revisionId: "sha256:next",
      featureId: "desktop-release",
      description: "Desktop release desktop-v1",
      changes: [
        {
          path: "src/app.ts",
          baseHash: "sha256:base",
          nextHash: "sha256:next",
        },
      ],
    },
  ],
};

const sha = `sha256:${"a".repeat(64)}`;

describe("recordDesktopUpdateSourceHistory", () => {
  it("builds safe R2 manifest URLs for installed desktop tags", () => {
    expect(
      desktopReleaseManifestUrl(
        "desktop-v0.0.2",
        "https://example.test/desktop/releases/",
      ),
    ).toBe(
      "https://example.test/desktop/releases/desktop-v0.0.2/manifest.json",
    );
    expect(() => desktopReleaseManifestUrl("../desktop-v0.0.2")).toThrow(
      "Desktop release tag is invalid",
    );
  });

  it("extracts source-history refs from desktop release manifests", () => {
    expect(
      sourceHistoryRefFromDesktopReleaseManifest(
        {
          commit: "b".repeat(40),
          sourceHistory: {
            url: "https://example.test/history.json",
            sha256: sha,
            size: 123,
          },
        },
        { targetCommit: "b".repeat(40) },
      ),
    ).toEqual({
      kind: "url",
      url: "https://example.test/history.json",
      sha256: sha,
      sizeBytes: 123,
    });
    expect(
      sourceHistoryRefFromDesktopReleaseManifest(
        {
          commit: "c".repeat(40),
          sourceHistory: {
            url: "https://example.test/history.json",
            sha256: sha,
            size: 123,
          },
        },
        { targetCommit: "b".repeat(40) },
      ),
    ).toBeNull();
    expect(
      sourceHistoryRefFromDesktopReleaseManifest(
        {
          sourceHistory: {
            url: "https://example.test/history.json",
            sha256: sha,
            size: 123,
          },
        },
        { targetCommit: "b".repeat(40) },
      ),
    ).toBeNull();
  });

  it("detects whether a desktop source pack starts at the installed base commit", () => {
    expect(
      desktopSourcePackMatchesBaseCommit(
        { ...sourcePack, baseRevisionId: `git:${"b".repeat(40)}` },
        "b".repeat(40),
      ),
    ).toBe(true);
    expect(
      desktopSourcePackMatchesBaseCommit(
        { ...sourcePack, baseRevisionId: `git:${"c".repeat(40)}` },
        "b".repeat(40),
      ),
    ).toBe(false);
  });

  it("rejects local source-pack apply when release content is hash-only", () => {
    expect(desktopSourcePackCanApplyLocally(sourcePack)).toBe(false);
    expect(
      desktopSourcePackCanApplyLocally({
        ...sourcePack,
        changeSets: [
          {
            ...sourcePack.changeSets[0],
            changes: [
              {
                path: "src/app.ts",
                baseHash: "sha256:base",
                nextHash: "sha256:next",
                base: { kind: "text", content: "base\n" },
                next: { kind: "text", content: "next\n" },
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("records official desktop source-pack identity through the runtime runner", async () => {
    const recordSourcePackHistory = vi.fn(async () => ({ ok: true as const }));

    await recordDesktopUpdateSourceHistory(
      { recordSourcePackHistory },
      {
        sourcePack,
        releaseTag: "desktop-v1",
        targetCommit: "a".repeat(40),
      },
    );

    expect(recordSourcePackHistory).toHaveBeenCalledWith({
      sourcePack,
      origin: "desktop-update",
      featureId: "desktop-release",
      description: "Desktop release desktop-v1",
      commitHash: "a".repeat(40),
    });
  });

  it("can record release history as official base history", async () => {
    const recordSourcePackHistory = vi.fn(async () => ({ ok: true as const }));

    await recordDesktopUpdateSourceHistory(
      { recordSourcePackHistory },
      {
        sourcePack,
        releaseTag: "desktop-v1",
        targetCommit: "b".repeat(40),
        origin: "official",
      },
    );

    expect(recordSourcePackHistory).toHaveBeenCalledWith({
      sourcePack,
      origin: "official",
      featureId: "desktop-release",
      description: "Desktop release desktop-v1",
      commitHash: "b".repeat(40),
    });
  });
});

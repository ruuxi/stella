import fs from "fs";
import os from "os";
import path from "path";
import type { App } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveBundledDefaultsPath,
  resolveDesktopRoot,
  resolveInstallRoot,
  resolveStellaHome,
} from "../../../electron/system/stella-home.js";

const tempRoots: string[] = [];

const createTempRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stella-home-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  delete process.env.STELLA_ROOT;
  delete process.env.STELLA_HOME;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("stella-home", () => {
  it("resolves runtime home at the install root and preserves desktop workspace", async () => {
    const installRoot = createTempRoot();
    const desktopRoot = path.join(installRoot, "desktop");
    fs.mkdirSync(path.join(desktopRoot, "resources", "stella-defaults", "core-skills", "theme-factory"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(desktopRoot, "resources", "stella-defaults", "extensions", "skills"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(
        desktopRoot,
        "resources",
        "stella-defaults",
        "core-skills",
        "theme-factory",
        "SKILL.md",
      ),
      "theme",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(
        desktopRoot,
        "resources",
        "stella-defaults",
        "extensions",
        "skills",
        ".gitkeep",
      ),
      "",
      "utf-8",
    );

    const mockApp = {
      getAppPath: () => desktopRoot,
      isPackaged: false,
    } as App;

    const stellaHome = await resolveStellaHome(mockApp);

    expect(resolveDesktopRoot(mockApp)).toBe(desktopRoot);
    expect(resolveInstallRoot(mockApp)).toBe(installRoot);
    expect(resolveBundledDefaultsPath(mockApp)).toBe(
      path.join(desktopRoot, "resources", "stella-defaults"),
    );
    expect(stellaHome.homePath).toBe(path.join(installRoot, ".stella"));
    expect(stellaHome.workspacePath).toBe(path.join(desktopRoot, "workspace"));
    expect(fs.existsSync(path.join(stellaHome.homePath, "agents"))).toBe(true);
    expect(
      fs.existsSync(path.join(stellaHome.homePath, "agents", "general", "AGENT.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(stellaHome.homePath, "agents", "self_mod", "AGENT.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(stellaHome.homePath, "core-skills", "theme-factory", "SKILL.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(stellaHome.homePath, "extensions", "skills", ".gitkeep")),
    ).toBe(true);
  });
});

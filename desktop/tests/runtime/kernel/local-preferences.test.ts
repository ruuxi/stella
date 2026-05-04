import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { loadLocalPreferences } from "../../../../runtime/kernel/preferences/local-preferences.js";

const makeStellaHome = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "stella-local-preferences-"));

const writePreferences = (
  stellaHome: string,
  preferences: Record<string, unknown>,
) => {
  const stateDir = path.join(stellaHome, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "preferences.json"),
    JSON.stringify(preferences),
  );
};

describe("loadLocalPreferences", () => {
  it("defaults wake-word listening off when the preference is missing", () => {
    const stellaHome = makeStellaHome();
    writePreferences(stellaHome, {});

    expect(loadLocalPreferences(stellaHome).wakeWordEnabled).toBe(false);
  });

  it("preserves an explicit wake-word preference", () => {
    const enabledHome = makeStellaHome();
    writePreferences(enabledHome, { wakeWordEnabled: true });

    expect(loadLocalPreferences(enabledHome).wakeWordEnabled).toBe(true);

    const disabledHome = makeStellaHome();
    writePreferences(disabledHome, { wakeWordEnabled: false });

    expect(loadLocalPreferences(disabledHome).wakeWordEnabled).toBe(false);
  });
});

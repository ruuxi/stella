import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillsFromHome } from "../../../electron/core/runtime/agents/skills.js";
import { localActivateSkill } from "../../../electron/core/runtime/tools/local-tool-overrides.js";

const tempHomes: string[] = [];

const createTempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-skill-access-"));
  tempHomes.push(dir);
  return dir;
};

const writeSkill = (args: {
  home: string;
  skillId: string;
  markdown: string;
  subdir?: "skills" | "core-skills";
  enabled?: boolean;
}) => {
  const skillDir = path.join(args.home, args.subdir ?? "skills", args.skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), args.markdown);
  if (typeof args.enabled === "boolean") {
    fs.writeFileSync(path.join(skillDir, "stella.yaml"), `enabled: ${args.enabled}\n`);
  }
};

describe("skill access policy", () => {
  afterEach(() => {
    for (const home of tempHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("filters disabled skills out of the runtime catalog", async () => {
    const home = createTempHome();
    writeSkill({ home, skillId: "enabled-skill", markdown: "Enabled instructions", enabled: true });
    writeSkill({ home, skillId: "disabled-skill", markdown: "Disabled instructions", enabled: false });

    const skills = await loadSkillsFromHome(
      path.join(home, "skills"),
      path.join(home, "core-skills"),
    );

    expect(skills.map((skill) => skill.id)).toEqual(["enabled-skill"]);
  });

  it("does not activate or advertise disabled skills", async () => {
    const home = createTempHome();
    writeSkill({ home, skillId: "enabled-skill", markdown: "Enabled instructions", enabled: true });
    writeSkill({ home, skillId: "disabled-skill", markdown: "Disabled instructions", enabled: false });

    await expect(localActivateSkill({
      skillId: "enabled-skill",
      stellaHome: home,
    })).resolves.toBe("Enabled instructions");

    await expect(localActivateSkill({
      skillId: "disabled-skill",
      stellaHome: home,
    })).resolves.toContain("Skill 'disabled-skill' not found.");

    await expect(localActivateSkill({
      skillId: "disabled-skill",
      stellaHome: home,
    })).resolves.toContain("Available skills: enabled-skill");
  });
});

import { describe, expect, it } from "vitest";
import { extractPowerShellDeleteTargets, extractPythonDeleteTargets, } from "./deferred_delete_cli.js";
describe("deferred_delete_cli parsing", () => {
    it("extracts targets from PowerShell Remove-Item commands", () => {
        const command = "Remove-Item -Force -Recurse -Path \"./build\", './dist' ; Write-Host done";
        const targets = extractPowerShellDeleteTargets(command);
        expect(targets).toEqual(["./build", "./dist"]);
    });
    it("extracts targets from common python delete snippets", () => {
        const code = [
            "import os, shutil",
            "os.remove('a.txt')",
            "shutil.rmtree(\"tmp\")",
            "from pathlib import Path",
            "Path('c.log').unlink(missing_ok=True)",
        ].join(";");
        const targets = extractPythonDeleteTargets(code);
        expect(targets).toEqual(["a.txt", "tmp", "c.log"]);
    });
    it("returns no targets when there is no delete operation", () => {
        const command = "Get-ChildItem -Path .";
        const targets = extractPowerShellDeleteTargets(command);
        expect(targets).toEqual([]);
    });
});

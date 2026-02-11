import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFERRED_DELETE_RETENTION_MS, getDeferredDeletePaths, purgeExpiredDeferredDeletes, trashPathsForDeferredDelete, } from "./deferred_delete.js";
const tmpRoots = [];
const makeTmpRoot = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "stella-deferred-delete-"));
    tmpRoots.push(root);
    return root;
};
const exists = async (targetPath) => {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
};
afterEach(async () => {
    while (tmpRoots.length > 0) {
        const next = tmpRoots.pop();
        if (!next)
            continue;
        await fs.rm(next, { recursive: true, force: true });
    }
});
describe("deferred delete", () => {
    it("moves targets to Stella trash and writes metadata", async () => {
        const root = await makeTmpRoot();
        const stellaHome = path.join(root, ".stella");
        const projectRoot = path.join(root, "project");
        await fs.mkdir(projectRoot, { recursive: true });
        const filePath = path.join(projectRoot, "demo.txt");
        await fs.writeFile(filePath, "hello", "utf-8");
        const result = await trashPathsForDeferredDelete(["demo.txt"], {
            cwd: projectRoot,
            source: "test:rm",
            stellaHome,
        });
        expect(result.errors).toHaveLength(0);
        expect(result.trashed).toHaveLength(1);
        expect(await exists(filePath)).toBe(false);
        const record = result.trashed[0];
        const paths = getDeferredDeletePaths(stellaHome);
        const metadataPath = path.join(paths.itemsDir, `${record.id}.json`);
        expect(await exists(record.trashPath)).toBe(true);
        expect(await exists(metadataPath)).toBe(true);
        expect(record.purgeAfter - record.trashedAt).toBe(DEFERRED_DELETE_RETENTION_MS);
    });
    it("respects force=true for missing paths", async () => {
        const root = await makeTmpRoot();
        const stellaHome = path.join(root, ".stella");
        const projectRoot = path.join(root, "project");
        await fs.mkdir(projectRoot, { recursive: true });
        const result = await trashPathsForDeferredDelete(["missing.txt"], {
            cwd: projectRoot,
            source: "test:rm",
            stellaHome,
            force: true,
        });
        expect(result.errors).toHaveLength(0);
        expect(result.trashed).toHaveLength(0);
        expect(result.skipped).toHaveLength(1);
    });
    it("purges expired trashed items", async () => {
        const root = await makeTmpRoot();
        const stellaHome = path.join(root, ".stella");
        const projectRoot = path.join(root, "project");
        await fs.mkdir(projectRoot, { recursive: true });
        const filePath = path.join(projectRoot, "delete-me.txt");
        await fs.writeFile(filePath, "trash me", "utf-8");
        const trashResult = await trashPathsForDeferredDelete(["delete-me.txt"], {
            cwd: projectRoot,
            source: "test:rm",
            stellaHome,
        });
        expect(trashResult.trashed).toHaveLength(1);
        const record = trashResult.trashed[0];
        const paths = getDeferredDeletePaths(stellaHome);
        const metadataPath = path.join(paths.itemsDir, `${record.id}.json`);
        const sweep = await purgeExpiredDeferredDeletes({
            stellaHome,
            now: record.purgeAfter + 1,
        });
        expect(sweep.errors).toHaveLength(0);
        expect(sweep.purged).toBe(1);
        expect(await exists(record.trashPath)).toBe(false);
        expect(await exists(metadataPath)).toBe(false);
    });
});

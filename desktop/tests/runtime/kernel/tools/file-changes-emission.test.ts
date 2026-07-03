import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  handleEdit,
  handleWrite,
} from "../../../../../runtime/kernel/tools/file.js";
import { handleApplyPatch } from "../../../../../runtime/kernel/tools/apply-patch.js";
import {
  createShellState,
  handleExecCommand,
  handleWriteStdin,
} from "../../../../../runtime/kernel/tools/shell.js";
import { createAsyncTempDirTracker } from "../../../helpers/temp.js";

const tempDirs = createAsyncTempDirTracker();

afterEach(() => tempDirs.cleanup());

const createTempDir = async () => {
  return await tempDirs.create("stella-file-changes-");
};

describe("fileChanges emission", () => {
  it("Write emits an `add` change for a brand-new file", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "new", "fresh.txt");

    const result = await handleWrite({ file_path: filePath, content: "hi" });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      { path: filePath, kind: { type: "add" } },
    ]);
    expect(await readFile(filePath, "utf-8")).toBe("hi");
  });

  it("Write emits an `update` change when the file already existed", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "existing.txt");
    await writeFile(filePath, "old", "utf-8");

    const result = await handleWrite({ file_path: filePath, content: "new" });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      { path: filePath, kind: { type: "update" } },
    ]);
  });

  it("Write does not emit fileChanges on error", async () => {
    const result = await handleWrite({
      file_path: "",
      content: "irrelevant",
    });
    expect(result.error).toBeDefined();
    expect(result.fileChanges).toBeUndefined();
  });

  it("Write rejects a relative path with a clear error", async () => {
    const root = await createTempDir();
    const result = await handleWrite(
      { file_path: path.join("nested", "rel.txt"), content: "nope" },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );
    expect(result.error).toMatch(/File tool paths must be absolute/);
    expect(result.error).toMatch(/nested/);
    expect(result.fileChanges).toBeUndefined();
  });

  it("Edit rejects a relative path with a clear error", async () => {
    const root = await createTempDir();
    const result = await handleEdit(
      {
        file_path: "rel-edit.txt",
        old_string: "a",
        new_string: "b",
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );
    expect(result.error).toMatch(
      /File tool paths must be absolute. Received relative path 'rel-edit\.txt'/,
    );
  });

  it("Write accepts a ~-prefixed path (expands to absolute under HOME)", async () => {
    const home = process.env.HOME ?? "";
    expect(home.length).toBeGreaterThan(0);
    const rel = `.stella-test-${Date.now()}.txt`;
    const result = await handleWrite({
      file_path: `~/${rel}`,
      content: "tilde",
    });
    expect(result.error).toBeUndefined();
    const written = path.join(home, rel);
    expect(await readFile(written, "utf-8")).toBe("tilde");
    await rm(written, { force: true });
  });

  it("Edit emits an `update` change for a successful replacement", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "edit-me.txt");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8");

    const result = await handleEdit({
      file_path: filePath,
      old_string: "beta",
      new_string: "BETA",
    });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      { path: filePath, kind: { type: "update" } },
    ]);
  });

  it("Edit returns no fileChanges when the replacement fails", async () => {
    const root = await createTempDir();
    const filePath = path.join(root, "edit-me.txt");
    await writeFile(filePath, "alpha\n", "utf-8");

    const result = await handleEdit({
      file_path: filePath,
      old_string: "missing",
      new_string: "x",
    });

    expect(result.error).toBeDefined();
    expect(result.fileChanges).toBeUndefined();
  });

  it("apply_patch emits one fileChange per parsed op (add / update / delete)", async () => {
    const root = await createTempDir();
    const updatePath = path.join(root, "update.txt");
    const deletePath = path.join(root, "delete.txt");
    const addPath = path.join(root, "add.txt");
    await writeFile(updatePath, "old\n", "utf-8");
    await writeFile(deletePath, "bye\n", "utf-8");

    const patch = `*** Begin Patch
*** Update File: ${updatePath}
@@
-old
+new
*** Delete File: ${deletePath}
*** Add File: ${addPath}
+hello world
*** End Patch`;

    const result = await handleApplyPatch({ input: patch });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      { path: updatePath, kind: { type: "update" } },
      { path: deletePath, kind: { type: "delete" } },
      { path: addPath, kind: { type: "add" } },
    ]);
  });

  it("apply_patch carries `move_path` when an Update has a Move to header", async () => {
    const root = await createTempDir();
    const fromPath = path.join(root, "from.txt");
    const toPath = path.join(root, "renamed", "to.txt");
    await writeFile(fromPath, "alpha\nbeta\n", "utf-8");

    const patch = `*** Begin Patch
*** Update File: ${fromPath}
*** Move to: ${toPath}
@@
 alpha
-beta
+BETA
*** End Patch`;

    const result = await handleApplyPatch({ input: patch });

    expect(result.error).toBeUndefined();
    expect(result.fileChanges).toEqual([
      {
        path: fromPath,
        kind: { type: "update", move_path: toPath },
      },
    ]);
  });

  it("apply_patch returns no fileChanges when parsing fails", async () => {
    const result = await handleApplyPatch({
      input: "this is not a patch envelope",
    });
    expect(result.error).toBeDefined();
    expect(result.fileChanges).toBeUndefined();
  });

  it("exec_command emits producedFiles for foreground shell mutations", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const filePath = path.join(root, "shell-created.md");

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf '# hello' > shell-created.md",
        workdir: root,
        yield_time_ms: 1000,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toEqual([
      { path: filePath, kind: { type: "add" } },
    ]);
  });

  it("exec_command skips produced-file snapshots for known read-only commands", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const initialFile = path.join(root, "initial.txt");
    const createdDuringCommand = path.join(root, "created-during-tail.txt");
    await writeFile(initialFile, "hello\n", "utf-8");

    const started = await handleExecCommand(
      shellState,
      {
        cmd: "tail -f initial.txt",
        workdir: root,
        yield_time_ms: 100,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(started.error).toBeUndefined();
    const sessionId = (started.result as { session_id: string | null })
      .session_id;
    expect(typeof sessionId).toBe("string");

    await writeFile(createdDuringCommand, "not from tail\n", "utf-8");
    shellState.shells.get(sessionId!)?.kill();

    const finished = await handleWriteStdin(
      shellState,
      {
        session_id: sessionId,
        chars: "",
        yield_time_ms: 1000,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(finished.error).toBeUndefined();
    expect(finished.producedFiles).toBeUndefined();
  });

  it("exec_command snapshots stellaAppDir when cwd is a subdirectory", async () => {
    const root = await createTempDir();
    const workdir = path.join(root, "desktop");
    await mkdir(workdir, { recursive: true });
    const shellState = createShellState(root);
    const filePath = path.join(root, "sibling-artifact.md");

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf '# hello' > ../sibling-artifact.md",
        workdir,
        yield_time_ms: 1000,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toEqual([
      { path: filePath, kind: { type: "add" } },
    ]);
  });

  it("exec_command snapshots explicit workdir when it is outside stellaAppDir", async () => {
    const stellaAppDir = await createTempDir();
    const externalRoot = await createTempDir();
    const shellState = createShellState(stellaAppDir);
    const filePath = path.join(externalRoot, "external-report.pdf");

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf '%PDF-1.4' > external-report.pdf",
        workdir: externalRoot,
        yield_time_ms: 1000,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toEqual([
      { path: filePath, kind: { type: "add" } },
    ]);
  });

  it("exec_command ignores build outputs before enforcing the snapshot cap", async () => {
    const root = await createTempDir();
    const targetDir = path.join(root, "target");
    await mkdir(targetDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 20_010 }, (_, index) =>
        writeFile(path.join(targetDir, `artifact-${index}.txt`), ""),
      ),
    );

    const shellState = createShellState(root);
    const filePath = path.join(root, "reported.md");

    const result = await handleExecCommand(
      shellState,
      {
        cmd: "printf '# hello' > reported.md",
        workdir: root,
        yield_time_ms: 1000,
      },
      {
        conversationId: "c1",
        deviceId: "d1",
        requestId: "r1",
        stellaAppDir: root,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toEqual([
      { path: filePath, kind: { type: "add" } },
    ]);
  });

  it("write_stdin emits final producedFiles for an interactive exec_command session", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const context = {
      conversationId: "c1",
      deviceId: "d1",
      requestId: "r1",
      stellaAppDir: root,
    };
    const filePath = path.join(root, "interactive-created.md");

    const started = await handleExecCommand(
      shellState,
      {
        cmd: 'read line; printf "%s" "$line" > interactive-created.md',
        workdir: root,
        yield_time_ms: 100,
      },
      context,
    );

    const sessionId = (started.result as { session_id: string | null })
      .session_id;
    expect(typeof sessionId).toBe("string");

    const finished = await handleWriteStdin(
      shellState,
      {
        session_id: sessionId,
        chars: "# hello\n",
        yield_time_ms: 1000,
      },
      context,
    );

    expect(finished.error).toBeUndefined();
    expect(finished.producedFiles).toEqual([
      { path: filePath, kind: { type: "add" } },
    ]);

    const repeated = await handleWriteStdin(
      shellState,
      {
        session_id: sessionId,
        chars: "",
        yield_time_ms: 10,
      },
      context,
    );

    expect(repeated.error).toBeUndefined();
    expect(repeated.producedFiles).toBeUndefined();
  });

  const execContext = (root: string) => ({
    conversationId: "c1",
    deviceId: "d1",
    requestId: "r1",
    stellaAppDir: root,
  });

  it("exec_command reports nothing for a read-heavy command (non-allowlisted reads)", async () => {
    const root = await createTempDir();
    await writeFile(path.join(root, "a.txt"), "alpha\n", "utf-8");
    await writeFile(path.join(root, "b.txt"), "beta\n", "utf-8");
    const shellState = createShellState(root);

    // `bash -c` is not on the known-safe list, so the snapshot machinery
    // runs — and must find nothing, because reading files is not producing
    // them.
    const result = await handleExecCommand(
      shellState,
      {
        cmd: "bash -c 'cat a.txt b.txt > /dev/null; grep -c alpha a.txt'",
        workdir: root,
        yield_time_ms: 2000,
      },
      execContext(root),
    );

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toBeUndefined();
  });

  it("exec_command drops a bulk seed into a mentioned external directory (spawned-bootstrap churn)", async () => {
    const root = await createTempDir();
    const external = await createTempDir();
    const dataDir = path.join(external, "stella-data");
    const shellState = createShellState(root);

    // Simulates a launched dev instance seeding its fresh data dir with
    // bundled agent/skill manifests: the command mentions the dir (making it
    // an external snapshot candidate) and 20 files appear inside it.
    const seed = Array.from(
      { length: 20 },
      (_, index) => `printf x > "${dataDir}/agent-${index}.md"`,
    ).join(" && ");
    const result = await handleExecCommand(
      shellState,
      {
        cmd: `mkdir -p "${dataDir}" && ${seed}`,
        workdir: root,
        yield_time_ms: 5000,
      },
      execContext(root),
    );

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toBeUndefined();
  });

  it("exec_command drops bulk mtime churn in the workspace (checkout-style rewrites)", async () => {
    const root = await createTempDir();
    const docs = path.join(root, "agents");
    await mkdir(docs, { recursive: true });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFile(path.join(docs, `doc-${index}.md`), "original\n", "utf-8"),
      ),
    );
    const shellState = createShellState(root);

    // Rewrite every tracked file in place (what git checkout / worktree sync
    // does): none of these are deliverables the agent produced.
    const result = await handleExecCommand(
      shellState,
      {
        cmd: 'for f in agents/*.md; do printf rewritten > "$f"; done',
        workdir: root,
        yield_time_ms: 5000,
      },
      execContext(root),
    );

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toBeUndefined();
  });

  it("exec_command still reports a small genuine output alongside filtered noise", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const reportPath = path.join(root, "report.md");
    const dataPath = path.join(root, "data.csv");

    const result = await handleExecCommand(
      shellState,
      {
        // Two deliverables plus collection-time noise: a log file and a
        // hidden profile dir. Only the deliverables may surface.
        cmd: "printf '# r' > report.md && printf 'a,b' > data.csv && printf noise > run.log && mkdir -p .profile && printf x > .profile/state",
        workdir: root,
        yield_time_ms: 5000,
      },
      execContext(root),
    );

    expect(result.error).toBeUndefined();
    expect(result.producedFiles).toEqual(
      expect.arrayContaining([
        { path: reportPath, kind: { type: "add" } },
        { path: dataPath, kind: { type: "add" } },
      ]),
    );
    expect(result.producedFiles).toHaveLength(2);
  });

  it("write_stdin drops bulk churn produced while a session ran (background seeding)", async () => {
    const root = await createTempDir();
    const shellState = createShellState(root);
    const context = execContext(root);

    const started = await handleExecCommand(
      shellState,
      {
        cmd: 'read line; for i in $(seq 1 20); do printf x > "seeded-$i.md"; done',
        workdir: root,
        yield_time_ms: 100,
      },
      context,
    );
    const sessionId = (started.result as { session_id: string | null })
      .session_id;
    expect(typeof sessionId).toBe("string");

    const finished = await handleWriteStdin(
      shellState,
      {
        session_id: sessionId,
        chars: "go\n",
        yield_time_ms: 5000,
      },
      context,
    );

    expect(finished.error).toBeUndefined();
    expect(finished.producedFiles).toBeUndefined();
  });
});

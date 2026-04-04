import fs from "fs";
import path from "path";
import type { RuntimeMemory, RuntimeRunEvent, RuntimeThreadMessage } from "./shared.js";
import { fileSafeId } from "./shared.js";
import { ensurePrivateDirSync } from "../shared/private-fs.js";

const PRIVATE_FILE_MODE = 0o600;

const ensureDir = (dirPath: string): void => {
  ensurePrivateDirSync(dirPath);
};

const ensureParentDir = (filePath: string): void => {
  ensureDir(path.dirname(filePath));
};

const appendJsonl = (filePath: string, value: unknown): void => {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
};

const writeJsonl = (filePath: string, rows: unknown[]): void => {
  if (rows.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }
  ensureParentDir(filePath);
  const lines = rows.map((row) => JSON.stringify(row));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, {
    encoding: "utf-8",
    mode: PRIVATE_FILE_MODE,
  });
};

export class TranscriptMirror {
  readonly chatTranscriptsDir: string;
  readonly runtimeThreadsDir: string;
  readonly runtimeThreadArchiveDir: string;
  readonly runtimeRunsDir: string;
  readonly runtimeMemoryFile: string;

  constructor(stateRoot: string) {
    const transcriptsRoot = path.join(stateRoot, "transcripts");
    this.chatTranscriptsDir = path.join(transcriptsRoot, "chat");
    this.runtimeThreadsDir = path.join(transcriptsRoot, "runtime", "threads");
    this.runtimeThreadArchiveDir = path.join(this.runtimeThreadsDir, "archive");
    this.runtimeRunsDir = path.join(transcriptsRoot, "runtime", "runs");
    this.runtimeMemoryFile = path.join(transcriptsRoot, "runtime", "memories.jsonl");

    ensureDir(this.chatTranscriptsDir);
    ensureDir(this.runtimeThreadsDir);
    ensureDir(this.runtimeThreadArchiveDir);
    ensureDir(this.runtimeRunsDir);
  }

  chatTranscriptFilePath(conversationId: string): string {
    return path.join(this.chatTranscriptsDir, `${fileSafeId(conversationId)}.jsonl`);
  }

  runtimeThreadFilePath(threadKey: string): string {
    return path.join(this.runtimeThreadsDir, `${fileSafeId(threadKey)}.jsonl`);
  }

  runtimeRunFilePath(runId: string): string {
    return path.join(this.runtimeRunsDir, `${fileSafeId(runId)}.jsonl`);
  }

  writeChatTranscript(conversationId: string, rows: unknown[]): void {
    writeJsonl(this.chatTranscriptFilePath(conversationId), rows);
  }

  appendChatTranscript(conversationId: string, row: unknown): void {
    appendJsonl(this.chatTranscriptFilePath(conversationId), row);
  }

  chatTranscriptMirrorExists(conversationId: string): boolean {
    return fs.existsSync(this.chatTranscriptFilePath(conversationId));
  }

  appendRuntimeThreadMessage(threadKey: string, row: RuntimeThreadMessage): void {
    appendJsonl(this.runtimeThreadFilePath(threadKey), row);
  }

  writeRuntimeThread(threadKey: string, rows: RuntimeThreadMessage[]): void {
    writeJsonl(this.runtimeThreadFilePath(threadKey), rows);
  }

  archiveRuntimeThread(threadKey: string, rows: RuntimeThreadMessage[]): string | null {
    if (rows.length === 0) {
      return null;
    }
    const threadArchiveDir = path.join(this.runtimeThreadArchiveDir, fileSafeId(threadKey));
    ensureDir(threadArchiveDir);
    const archivedPath = path.join(threadArchiveDir, `${Date.now()}.jsonl`);
    writeJsonl(archivedPath, rows);
    return archivedPath;
  }

  appendRuntimeRunEvent(runId: string, row: RuntimeRunEvent): void {
    appendJsonl(this.runtimeRunFilePath(runId), row);
  }

  writeRuntimeRun(runId: string, rows: RuntimeRunEvent[]): void {
    writeJsonl(this.runtimeRunFilePath(runId), rows);
  }

  appendRuntimeMemory(row: RuntimeMemory): void {
    appendJsonl(this.runtimeMemoryFile, row);
  }

  writeRuntimeMemories(rows: RuntimeMemory[]): void {
    writeJsonl(this.runtimeMemoryFile, rows);
  }

  runtimeThreadMirrorExists(threadKey: string): boolean {
    return fs.existsSync(this.runtimeThreadFilePath(threadKey));
  }

  runtimeRunMirrorExists(runId: string): boolean {
    return fs.existsSync(this.runtimeRunFilePath(runId));
  }

  runtimeMemoryMirrorExists(): boolean {
    return fs.existsSync(this.runtimeMemoryFile);
  }
}

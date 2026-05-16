/**
 * Per-turn primary-resource derivation — Codex-style.
 *
 * Mirrors Codex's `ga(turn)` + `vde(...)` pipeline in
 * `send-app-server-request-BTldVjKF.js` and `index-CxBol07n.js`:
 *
 *   1. Walk every `tool_result` in the turn and collect normalized
 *      `fileChanges` records (explicit Codex-style edit provenance) plus
 *      Stella `producedFiles` records (user-facing outputs detected from
 *      shell/CLI side effects).
 *   2. Collect `referencedFilePaths` from
 *        - office preview refs (which are "look at this file" signals,
 *          not edits, so they belong with referenced files)
 *        - markdown links in the assistant message text
 *   3. Combine both pools (deduped by absolute path) and feed into
 *      `pickPrimaryEditedPath` (our equivalent of Codex's `vde`):
 *      a single office/PDF/media artifact wins; otherwise we only
 *      surface a pill if the entire turn touched exactly one
 *      previewable file.
 *
 * The runtime is the source of truth for what was edited. The chat
 * surface no longer sniffs tool names like `Write`, `Edit`, or
 * `apply_patch` — any new file-mutating tool that emits structured
 * `fileChanges` automatically participates in the resource pill.
 */

import { isOfficePreviewRef } from "../../../../../runtime/contracts/office-preview.js";
import {
  type FileChangeRecord,
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  type ProducedFileRecord,
} from "../../../../../runtime/contracts/file-changes.js";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import type { OfficePreviewRef } from "../../../../../runtime/contracts/office-preview.js";
import {
  kindForPath,
  basenameOf,
  extensionOf,
  fileArtifactPayloadForPath,
  isDeveloperResourceExtension,
  pickPrimaryEditedPath,
} from "@/shell/display/path-to-viewer";
import type { EventRecord } from "./event-transforms";
import {
  isAgentCompletedEvent,
  isToolRequest,
  isToolResult,
} from "./event-transforms";

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const requestedSizeFromRecord = (
  value: unknown,
): { width: number; height: number } | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const width =
    typeof record.width === "number" && Number.isFinite(record.width)
      ? Math.floor(record.width)
      : null;
  const height =
    typeof record.height === "number" && Number.isFinite(record.height)
      ? Math.floor(record.height)
      : null;
  return width !== null && height !== null && width > 0 && height > 0
    ? { width, height }
    : null;
};

type PayloadByPath = Map<string, DisplayPayload>;

type ResolvedFileChange = {
  path: string;
  kind: FileChangeRecord["kind"]["type"];
  timestamp: number;
};

const normalizePosixPath = (candidate: string): string => {
  const trimmed = candidate.trim();
  if (!trimmed) return trimmed;
  const leadingSlash = trimmed.startsWith("/");
  const segments: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `${leadingSlash ? "/" : ""}${segments.join("/")}`;
};

const resolvePathAgainstCwd = (
  candidate: string,
  cwd: string | undefined,
): string | null => {
  const trimmed = asNonEmptyString(candidate);
  const base = asNonEmptyString(cwd);
  if (!trimmed || !base || !base.startsWith("/")) return null;
  if (trimmed.startsWith("/")) return normalizePosixPath(trimmed);
  return normalizePosixPath(`${base.replace(/\/+$/g, "")}/${trimmed}`);
};

const resolveRelativePathFromKnownAbsolute = (
  candidate: string,
  absoluteCandidates: string[],
): string | null => {
  const trimmed = asNonEmptyString(candidate);
  if (!trimmed || trimmed.startsWith("/")) return null;
  // Without a turn cwd we can still dedupe common `./foo/bar.pdf` links by
  // matching them against the absolute edited / referenced paths we already
  // collected for this turn.
  if (trimmed.startsWith("../")) return null;
  const suffix = normalizePosixPath(trimmed).replace(/^\/+/, "");
  if (!suffix) return null;
  const matches = absoluteCandidates.filter(
    (existing) => existing === suffix || existing.endsWith(`/${suffix}`),
  );
  return matches.length === 1 ? matches[0]! : null;
};

const fileChangesForResult = (event: EventRecord): FileChangeRecord[] => {
  if (!isToolResult(event) && !isAgentCompletedEvent(event)) return [];
  const candidate = (event.payload as { fileChanges?: unknown } | undefined)
    ?.fileChanges;
  return isFileChangeRecordArray(candidate) ? candidate : [];
};

const producedFilesForResult = (event: EventRecord): ProducedFileRecord[] => {
  if (!isToolResult(event) && !isAgentCompletedEvent(event)) return [];
  const candidate = (event.payload as { producedFiles?: unknown } | undefined)
    ?.producedFiles;
  return isProducedFileRecordArray(candidate) ? candidate : [];
};

const officeRefForResult = (event: EventRecord): OfficePreviewRef | null => {
  if (!isToolResult(event)) return null;
  const ref = (event.payload as { officePreviewRef?: unknown })
    .officePreviewRef;
  return isOfficePreviewRef(ref) ? ref : null;
};

/**
 * Resolve a fileChange record into the canonical post-mutation path,
 * exactly like Codex's `pa`:
 *   - `update` with `move_path` → use the new location
 *   - `update` without `move_path` / `add` → use `path`
 *   - `delete` → produces no edited path; deleted files can't be
 *     previewed.
 */
const resolveFileChange = (
  record: FileChangeRecord,
  timestamp: number,
): ResolvedFileChange | null => {
  const kindType = record.kind.type;
  if (kindType === "delete") return null;
  const path =
    kindType === "update" && record.kind.move_path
      ? record.kind.move_path
      : record.path;
  const trimmed = asNonEmptyString(path);
  if (!trimmed) return null;
  return { path: trimmed, kind: kindType, timestamp };
};

/**
 * Pull `image_gen` rich metadata (jobId / prompt / capability) out of a
 * tool_result so the in-sidebar viewer keeps its prompt context. We
 * still rely on the tool's `fileChanges` for path collection, but the
 * rich metadata lives in `details` and isn't part of the `fileChange`
 * contract.
 */
const imageGenPayloadsByPath = (
  toolEvents: EventRecord[],
): Map<string, DisplayPayload> => {
  const byPath = new Map<string, DisplayPayload>();

  for (const event of toolEvents) {
    if (!isToolResult(event)) continue;
    if (event.payload.toolName !== "image_gen" || event.payload.error) continue;
    const result = event.payload.result;
    if (!result || typeof result !== "object") continue;
    const record = result as Record<string, unknown>;
    const rawPaths = record.filePaths;
    if (!Array.isArray(rawPaths)) continue;
    const filePaths = rawPaths.filter(
      (filePath): filePath is string =>
        typeof filePath === "string" && filePath.trim().length > 0,
    );
    if (filePaths.length === 0) continue;
    const payload: DisplayPayload = {
      kind: "media",
      asset: { kind: "image", filePaths },
      createdAt: event.timestamp,
      ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
      ...(typeof record.capability === "string"
        ? { capability: record.capability }
        : {}),
      ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
      ...(typeof record.aspectRatio === "string"
        ? { aspectRatio: record.aspectRatio }
        : {}),
      ...(requestedSizeFromRecord(record.requestedSize)
        ? { requestedSize: requestedSizeFromRecord(record.requestedSize)! }
        : {}),
      ...((event.payload as { agentType?: unknown }).agentType ===
      "orchestrator"
        ? { presentation: "inline-image" as const }
        : {}),
    };
    for (const filePath of filePaths) {
      if (!byPath.has(filePath)) byPath.set(filePath, payload);
    }
  }

  return byPath;
};

/**
 * Pull the orchestrator's last `html` tool result for this turn and build
 * a file-backed `canvas-html` payload from it. The tool writes a
 * self-contained HTML document under `state/outputs/html/<slug>.html` and
 * we surface it as both an inline artifact card AND a Canvas display tab.
 *
 * Mirrors `inlineImageGenSubmissionPayload`: orchestrator-only, latest
 * call wins (the assistant rarely emits more than one canvas per turn,
 * but if it does, the freshest one is the right artifact to anchor the
 * row).
 */
const orchestratorHtmlPayload = (
  toolEvents: EventRecord[],
): DisplayPayload | null => {
  for (let index = toolEvents.length - 1; index >= 0; index -= 1) {
    const event = toolEvents[index]!;
    if (!isToolResult(event)) continue;
    if (event.payload.toolName !== "html" || event.payload.error) continue;
    if (
      (event.payload as { agentType?: unknown }).agentType !== "orchestrator"
    ) {
      continue;
    }
    const candidate =
      event.payload.details && typeof event.payload.details === "object"
        ? event.payload.details
        : event.payload.result;
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const filePath = asNonEmptyString(record.filePath);
    if (!filePath) continue;
    const title = asNonEmptyString(record.title) ?? undefined;
    const slug = asNonEmptyString(record.slug) ?? undefined;
    const createdAtNum =
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
        ? record.createdAt
        : event.timestamp;
    return {
      kind: "canvas-html",
      filePath,
      ...(title ? { title } : {}),
      ...(slug ? { slug } : {}),
      createdAt: createdAtNum,
    };
  }
  return null;
};

/**
 * Pull a `canvas-html` payload from any tool-result this turn whose
 * `fileChanges` touch `state/outputs/html/*.html`. Lets the general
 * agent (or any future tool that uses `apply_patch`/`exec_command`)
 * write a canvas to the same conventional output dir and have it
 * surface as an inline artifact + Canvas tab, the same way the
 * orchestrator's `html` tool does. The orchestrator's richer
 * (title-carrying) result is preferred — this is the fallback when no
 * orchestrator html tool was used. Latest write in the turn wins.
 */
const HTML_OUTPUT_PATH_RE = /(?:^|\/)state\/outputs\/html\/([^/]+)\.html$/;

const titleFromHtmlSlug = (slug: string): string => {
  const trimmed = slug.trim();
  if (!trimmed) return "Canvas";
  return trimmed
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
};

const fileChangeHtmlOutputPayload = (
  toolEvents: EventRecord[],
): DisplayPayload | null => {
  let latest:
    | { filePath: string; slug: string; createdAt: number }
    | null = null;
  for (const event of toolEvents) {
    if (!isToolResult(event)) continue;
    if ((event.payload as { error?: unknown }).error) continue;
    for (const record of fileChangesForResult(event)) {
      const resolved = resolveFileChange(record, event.timestamp);
      if (!resolved) continue;
      const match = HTML_OUTPUT_PATH_RE.exec(resolved.path);
      if (!match) continue;
      if (!latest || resolved.timestamp >= latest.createdAt) {
        latest = {
          filePath: resolved.path,
          slug: match[1]!,
          createdAt: resolved.timestamp,
        };
      }
    }
  }
  if (!latest) return null;
  return {
    kind: "canvas-html",
    filePath: latest.filePath,
    title: titleFromHtmlSlug(latest.slug),
    slug: latest.slug,
    createdAt: latest.createdAt,
  };
};

const inlineImageGenSubmissionPayload = (
  toolEvents: EventRecord[],
): DisplayPayload | null => {
  for (let index = toolEvents.length - 1; index >= 0; index -= 1) {
    const event = toolEvents[index]!;
    if (!isToolResult(event)) continue;
    if (event.payload.toolName !== "image_gen" || event.payload.error) continue;
    if (
      (event.payload as { agentType?: unknown }).agentType !== "orchestrator"
    ) {
      continue;
    }
    const candidate =
      event.payload.details && typeof event.payload.details === "object"
        ? event.payload.details
        : event.payload.result;
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const jobId = asNonEmptyString(record.jobId);
    if (!jobId) continue;
    const rawPaths = record.filePaths;
    const filePaths = Array.isArray(rawPaths)
      ? rawPaths.filter(
          (filePath): filePath is string =>
            typeof filePath === "string" && filePath.trim().length > 0,
        )
      : [];
    return {
      kind: "media",
      asset: { kind: "image", filePaths },
      jobId,
      ...(typeof record.capability === "string"
        ? { capability: record.capability }
        : {}),
      ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
      ...(typeof record.aspectRatio === "string"
        ? { aspectRatio: record.aspectRatio }
        : {}),
      ...(requestedSizeFromRecord(record.requestedSize)
        ? { requestedSize: requestedSizeFromRecord(record.requestedSize)! }
        : {}),
      presentation: "inline-image",
      createdAt: event.timestamp,
    };
  }
  return null;
};

export const buildPayloadFromBarePath = (
  filePath: string,
  createdAt: number,
  options?: {
    produced?: boolean;
    developerResourcesEnabled?: boolean;
    patch?: string;
  },
): DisplayPayload | null => {
  // Canvas HTML artifacts live under `state/outputs/html/<slug>.html` and
  // need to surface as a `canvas-html` payload (not a generic .html source
  // diff) so the home overview's Recent files list, the inline chat card,
  // and the workspace Canvas tab all open the same viewer.
  const htmlMatch = HTML_OUTPUT_PATH_RE.exec(filePath);
  if (htmlMatch) {
    const slug = htmlMatch[1]!;
    return {
      kind: "canvas-html",
      filePath,
      title: titleFromHtmlSlug(slug),
      slug,
      createdAt,
    };
  }

  switch (kindForPath(filePath)) {
    case "markdown":
      return {
        kind: "markdown",
        filePath,
        title: basenameOf(filePath),
        createdAt,
      };
    case "office-document":
    case "office-spreadsheet":
    case "office-slides":
      if (options?.produced !== true) return null;
      return (
        fileArtifactPayloadForPath(filePath, createdAt) ?? {
          kind: "media",
          asset: {
            kind: "download",
            filePath,
            label: basenameOf(filePath),
          },
          createdAt,
        }
      );
    case "pdf":
      return { kind: "pdf", filePath };
    case "image":
      return {
        kind: "media",
        asset: { kind: "image", filePaths: [filePath] },
        createdAt,
      };
    case "video":
      return { kind: "media", asset: { kind: "video", filePath }, createdAt };
    case "audio":
      return { kind: "media", asset: { kind: "audio", filePath }, createdAt };
    case "model3d":
      return {
        kind: "media",
        asset: { kind: "model3d", filePath },
        createdAt,
      };
    default:
      if (
        options?.developerResourcesEnabled === true &&
        isDeveloperResourceExtension(extensionOf(filePath))
      ) {
        return {
          kind: "source-diff",
          filePath,
          title: basenameOf(filePath),
          ...(options.patch ? { patch: options.patch } : {}),
          createdAt,
        };
      }
      // Office files opened from bare edit paths still require a preview
      // session ref. Plain text fallbacks are unsupported by the viewers
      // today, so skip them rather than render a pill that does nothing.
      return null;
  }
};

const patchInputForToolCall = (
  toolEvents: EventRecord[],
  toolCallId: string | undefined,
): string | undefined => {
  if (!toolCallId) return undefined;
  const request = toolEvents.find(
    (event) =>
      isToolRequest(event) &&
      event.payload.toolName === "apply_patch" &&
      event.requestId === toolCallId,
  );
  const args = request && isToolRequest(request) ? request.payload.args : null;
  const input = args?.input ?? args?.patch;
  return typeof input === "string" && input.trim().length > 0
    ? input
    : undefined;
};

const requestIdForEvent = (event: EventRecord): string | undefined => {
  if (typeof event.requestId === "string" && event.requestId.trim()) {
    return event.requestId;
  }
  const payloadRequestId = (
    event.payload as { requestId?: unknown } | undefined
  )?.requestId;
  return typeof payloadRequestId === "string" && payloadRequestId.trim()
    ? payloadRequestId
    : undefined;
};

/**
 * Extract local file paths referenced via markdown links in the
 * assistant message text. Mirrors Codex's `yde` + `bde` pair: walk the
 * markdown for link nodes, decode the url, and discard anything that
 * looks like an http(s) / mailto link or otherwise isn't a local path.
 *
 * Uses a regex instead of a full markdown AST walk because we don't
 * already have the parsed tree on hand and the rules are simple.
 * Handles both `[text](url)` and `[text](<url>)` forms.
 */
// Two forms, matched in one pass:
//   - `[text](<url with spaces>)` → group 1 captures the angle-bracket
//     payload, which is allowed to contain whitespace
//   - `[text](url-without-spaces)` → group 2 captures the bare payload
const MARKDOWN_LINK_RE = /\[[^\]]*?\]\(\s*(?:<([^>]+)>|([^()<>\s]+))\s*\)/g;
const NON_FILE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export const extractMarkdownLinkPaths = (assistantText: string): string[] => {
  if (!assistantText) return [];
  const out: string[] = [];
  for (const match of assistantText.matchAll(MARKDOWN_LINK_RE)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    let decoded: string;
    try {
      decoded = decodeURI(raw);
    } catch {
      decoded = raw;
    }
    const trimmed = decoded.trim();
    if (!trimmed) continue;
    if (NON_FILE_URL_RE.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
};

const resolveReferencedMarkdownPath = (
  rawLinkPath: string,
  turnCwd: string | undefined,
  absoluteCandidates: string[],
): string | null => {
  const trimmed = asNonEmptyString(rawLinkPath);
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return normalizePosixPath(trimmed);
  return (
    resolvePathAgainstCwd(trimmed, turnCwd) ??
    resolveRelativePathFromKnownAbsolute(trimmed, absoluteCandidates) ??
    trimmed
  );
};

/**
 * Derive the primary `DisplayPayload` for a turn, or `null` if no
 * eligible artifact was touched.
 */
/**
 * Collect this turn's developer-resource source-diff payloads, in
 * edit order. Returns an empty array when the setting is off or no
 * developer files were edited.
 *
 * The list size doubles as the "N file changes" label (the chat
 * surface uses `.length`), and the payloads themselves feed the
 * singleton "Code changes" tab batch on click.
 *
 * Tool-agnostic — any tool that emits `fileChanges` participates
 * (apply_patch carries the unified-diff text in `patch`; write/edit
 * tools fall back to the file-bytes preview in `SourceDiffTabContent`).
 */
export const collectTurnSourceDiffPayloads = (
  toolEvents: EventRecord[],
  options?: { developerResourcesEnabled?: boolean },
): DisplayPayload[] => {
  if (options?.developerResourcesEnabled !== true) return [];
  if (toolEvents.length === 0) return [];
  const seen = new Set<string>();
  const payloads: DisplayPayload[] = [];
  for (const event of toolEvents) {
    const records = fileChangesForResult(event);
    for (const record of records) {
      const resolved = resolveFileChange(record, event.timestamp);
      if (!resolved) continue;
      if (!isDeveloperResourceExtension(extensionOf(resolved.path))) continue;
      if (seen.has(resolved.path)) continue;
      seen.add(resolved.path);
      const patch =
        isToolResult(event) && event.payload.toolName === "apply_patch"
          ? patchInputForToolCall(toolEvents, requestIdForEvent(event))
          : undefined;
      payloads.push({
        kind: "source-diff",
        filePath: resolved.path,
        title: basenameOf(resolved.path),
        ...(patch ? { patch } : {}),
        createdAt: resolved.timestamp,
      });
    }
  }
  return payloads;
};

export const deriveTurnResource = (
  toolEvents: EventRecord[],
  assistantText: string = "",
  turnCwd?: string,
  options?: { developerResourcesEnabled?: boolean },
): DisplayPayload | null => {
  if (toolEvents.length === 0 && !assistantText) return null;

  // The `html` canvas wins outright when present — its purpose is
  // "show this canvas inline + open it in the panel", and an HTML
  // canvas is never the same artifact as an unrelated edited file, so
  // we skip the file-pool merge and surface it directly. The
  // orchestrator's first-class `html` tool is preferred (it carries an
  // explicit title); otherwise any other tool (e.g. the general agent
  // via `apply_patch`/`exec_command`) writing to
  // `state/outputs/html/*.html` is treated the same way.
  const htmlPayload =
    orchestratorHtmlPayload(toolEvents) ??
    fileChangeHtmlOutputPayload(toolEvents);
  if (htmlPayload) return htmlPayload;

  // Build payloadByPath using rich signals (office previews + image_gen
  // metadata) so the chosen path resolves to a previewer that keeps
  // session ids / prompts / capability context.
  const payloadByPath: PayloadByPath = new Map();
  const imagePayloads = imageGenPayloadsByPath(toolEvents);
  const inlineImageSubmissionPayload =
    inlineImageGenSubmissionPayload(toolEvents);
  if (inlineImageSubmissionPayload) return inlineImageSubmissionPayload;

  for (const [filePath, payload] of imagePayloads) {
    if (!payloadByPath.has(filePath)) {
      payloadByPath.set(filePath, payload);
    }
  }

  const referencedFromOffice = new Map<string, OfficePreviewRef>();

  for (const event of toolEvents) {
    const office = officeRefForResult(event);
    if (!office) continue;
    const path = office.sourcePath;
    if (!referencedFromOffice.has(path)) {
      referencedFromOffice.set(path, office);
    }
    if (!payloadByPath.has(path)) {
      payloadByPath.set(path, { kind: "office", previewRef: office });
    }
  }

  // Codex's "edited" pool = paths from explicit fileChange items.
  const editedPaths: string[] = [];
  const editedSeen = new Set<string>();
  for (const event of toolEvents) {
    const records = fileChangesForResult(event);
    for (const record of records) {
      const resolved = resolveFileChange(record, event.timestamp);
      if (!resolved) continue;
      if (editedSeen.has(resolved.path)) continue;
      editedSeen.add(resolved.path);
      editedPaths.push(resolved.path);
      if (!payloadByPath.has(resolved.path)) {
        const patch =
          isToolResult(event) && event.payload.toolName === "apply_patch"
            ? patchInputForToolCall(toolEvents, requestIdForEvent(event))
            : undefined;
        const inferred = buildPayloadFromBarePath(
          resolved.path,
          resolved.timestamp,
          {
            developerResourcesEnabled: options?.developerResourcesEnabled,
            ...(patch ? { patch } : {}),
          },
        );
        if (inferred) {
          payloadByPath.set(resolved.path, inferred);
        }
      }
    }
  }

  // Stella's produced-file pool = user-facing outputs detected from shell/CLI
  // side effects or rolled up from child agents. These are not Codex-style
  // explicit edit artifacts, but they should still surface in Stella's chat.
  const producedPaths: string[] = [];
  const producedSeen = new Set<string>();
  for (const event of toolEvents) {
    const records = producedFilesForResult(event);
    for (const record of records) {
      const resolved = resolveFileChange(record, event.timestamp);
      if (!resolved) continue;
      if (producedSeen.has(resolved.path) || editedSeen.has(resolved.path))
        continue;
      producedSeen.add(resolved.path);
      producedPaths.push(resolved.path);
      if (!payloadByPath.has(resolved.path)) {
        const inferred = buildPayloadFromBarePath(
          resolved.path,
          resolved.timestamp,
          {
            produced: true,
            developerResourcesEnabled: options?.developerResourcesEnabled,
          },
        );
        if (inferred) {
          payloadByPath.set(resolved.path, inferred);
        }
      }
    }
  }

  // Codex's "referenced" pool = office preview ref source paths +
  // markdown links in the assistant message text.
  const referencedPaths: string[] = [];
  const referencedSeen = new Set<string>();
  const absoluteCandidates = [
    ...editedPaths,
    ...producedPaths,
    ...referencedFromOffice.keys(),
  ]
    .filter((candidate) => candidate.startsWith("/"))
    .map(normalizePosixPath);
  const pushReferenced = (path: string | null) => {
    if (!path || referencedSeen.has(path) || editedSeen.has(path)) return;
    referencedSeen.add(path);
    referencedPaths.push(path);
  };
  for (const sourcePath of referencedFromOffice.keys())
    pushReferenced(sourcePath);
  for (const linkPath of extractMarkdownLinkPaths(assistantText)) {
    pushReferenced(
      resolveReferencedMarkdownPath(linkPath, turnCwd, absoluteCandidates),
    );
  }

  const candidatePaths = [...editedPaths, ...producedPaths, ...referencedPaths];
  if (candidatePaths.length === 0) return null;

  const primary = pickPrimaryEditedPath(candidatePaths, {
    includeDeveloperResources: options?.developerResourcesEnabled,
  });
  if (!primary) return null;

  const directPayload = payloadByPath.get(primary);
  if (directPayload) return directPayload;

  const fallbackTimestamp =
    toolEvents[toolEvents.length - 1]?.timestamp ?? Date.now();
  return buildPayloadFromBarePath(primary, fallbackTimestamp, {
    developerResourcesEnabled: options?.developerResourcesEnabled,
  });
};

import {
  MEDIA_SDK_BASE_PATH,
  MEDIA_SDK_DOCS_MARKDOWN_PATH,
  MEDIA_SDK_DOCS_PATH,
  MEDIA_SDK_JOB_CANCEL_PATH,
  MEDIA_SDK_JOB_RESULT_PATH,
  MEDIA_SDK_JOB_STATUS_PATH,
  MEDIA_SDK_JOBS_PATH,
  MEDIA_SDK_VERSION,
  listMediaServices,
} from "./media_sdk_catalog";

const renderExampleBody = (): string =>
  JSON.stringify(
    {
      service: "image-to-video",
      prompt: "Slow cinematic push-in over a neon diner at dusk.",
      imageUrl: "https://example.com/reference.png",
      options: {
        logs: true,
      },
    },
    null,
    2,
  );

export const buildMediaSdkDocument = (origin: string | null): {
  markdown: string;
  json: Record<string, unknown>;
} => {
  const services = listMediaServices();
  const serviceLines = services.map((service) => {
    const modes = [
      `inputs: ${service.inputModes.join(", ") || "none"}`,
      `outputs: ${service.outputModes.join(", ") || "none"}`,
      `mode: ${service.async ? "async job" : "sync response"}`,
    ].join(" | ");
    const docsLine = service.docsUrl ? ` | docs: ${service.docsUrl}` : "";
    const variantLine = service.llmVariants?.length
      ? ` | variants: ${service.llmVariants.join(", ")}`
      : "";
    return `- \`${service.id}\` - ${service.description} (${modes}${variantLine}${docsLine})`;
  });

  const docsJsonPath = origin ? `${origin}${MEDIA_SDK_DOCS_PATH}` : MEDIA_SDK_DOCS_PATH;
  const docsMarkdownPath = origin
    ? `${origin}${MEDIA_SDK_DOCS_MARKDOWN_PATH}`
    : MEDIA_SDK_DOCS_MARKDOWN_PATH;
  const jobsPath = origin ? `${origin}${MEDIA_SDK_JOBS_PATH}` : MEDIA_SDK_JOBS_PATH;
  const statusPath = origin ? `${origin}${MEDIA_SDK_JOB_STATUS_PATH}` : MEDIA_SDK_JOB_STATUS_PATH;
  const resultPath = origin ? `${origin}${MEDIA_SDK_JOB_RESULT_PATH}` : MEDIA_SDK_JOB_RESULT_PATH;
  const cancelPath = origin ? `${origin}${MEDIA_SDK_JOB_CANCEL_PATH}` : MEDIA_SDK_JOB_CANCEL_PATH;

  const markdown = [
    "# Stella Media SDK",
    "",
    `Version: ${MEDIA_SDK_VERSION}`,
    "",
    "This API hides provider and model names behind stable Stella service IDs. Do not send a `model` field.",
    "",
    "## Base URL",
    "",
    `- JSON docs: \`${docsJsonPath}\``,
    `- Markdown docs: \`${docsMarkdownPath}\``,
    `- Submit: \`${jobsPath}\``,
    `- Status: \`${statusPath}?jobId=...\``,
    `- Result: \`${resultPath}?jobId=...\``,
    `- Cancel: \`${cancelPath}\` with JSON body \`{ "jobId": "..." }\``,
    "",
    "## Auth",
    "",
    "- Docs are public and safe to fetch with curl.",
    "- Job execution requires Stella auth. Use the normal Stella session/token flow instead of embedding provider keys in apps.",
    "",
    "## Request Shape",
    "",
    "Send a POST request to `/api/media/v1/jobs`.",
    "",
    "Top-level convenience fields:",
    "- `service`: required Stella service ID",
    "- `prompt`, `imageUrl`, `videoUrl`, `audioUrl`, `text`, `voice`, `messages`: optional shortcuts",
    "- `input`: optional raw provider-native input object for the selected service",
    "- `options.logs`: include upstream queue logs on status lookups",
    "- `variant`: only for `llm`, use `best` or `fast`",
    "",
    "If a shortcut field and `input` both provide the same value, `input` wins.",
    "",
    "Example:",
    "```json",
    renderExampleBody(),
    "```",
    "",
    "## Response Shape",
    "",
    "- Async services return a signed `job.id` plus `statusUrl`, `resultUrl`, and `cancelUrl`.",
    "- Sync services return `mode: \"sync\"` and `output` immediately.",
    "",
    "## Services",
    "",
    ...serviceLines,
    "",
    "## Job Lifecycle",
    "",
    "- `GET /api/media/v1/jobs/status?jobId=...` for queue status",
    "- `GET /api/media/v1/jobs/result?jobId=...` for final output",
    "- `POST /api/media/v1/jobs/cancel` with `{ \"jobId\": \"...\" }` to cancel an async job",
    "",
    "## Notes",
    "",
    "- For fal-backed services, put service-specific request fields under `input` and follow the linked official docs for the exact schema.",
    "- For `llm` and `media-llm`, send an OpenAI-compatible chat body under `input` or use the top-level `messages` shortcut.",
    "- For `music`, call the same submit endpoint with `{ \"service\": \"music\" }` to receive a Lyria session API key.",
  ].join("\n");

  return {
    markdown,
    json: {
      version: MEDIA_SDK_VERSION,
      basePath: MEDIA_SDK_BASE_PATH,
      docsPath: MEDIA_SDK_DOCS_PATH,
      docsMarkdownPath: MEDIA_SDK_DOCS_MARKDOWN_PATH,
      jobsPath: MEDIA_SDK_JOBS_PATH,
      jobStatusPath: MEDIA_SDK_JOB_STATUS_PATH,
      jobResultPath: MEDIA_SDK_JOB_RESULT_PATH,
      jobCancelPath: MEDIA_SDK_JOB_CANCEL_PATH,
      services,
    },
  };
};

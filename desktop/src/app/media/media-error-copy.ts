export type MediaJobErrorLike =
  | {
      message?: string;
      code?: string;
    }
  | undefined;

export const friendlyImageGenerationFailure = (
  error: MediaJobErrorLike,
): string => {
  const code =
    typeof error?.code === "string" ? error.code.trim().toLowerCase() : "";
  switch (code) {
    case "request_timeout":
    case "timeout":
      return "Image generation took too long";
    case "startup_timeout":
      return "Image generation took too long to start";
    case "runner_scheduling_failure":
    case "runner_connection_timeout":
    case "runner_disconnected":
    case "runner_connection_refused":
    case "runner_connection_error":
      return "Image service is busy";
    case "runner_incomplete_response":
    case "payload_error":
      return "Image result could not be read";
    case "runner_server_error":
    case "internal_error":
      return "Image service hit a temporary error";
    case "bad_request":
      return "Image request was invalid";
    case "client_cancelled":
      return "Image generation was canceled";
    case "client_disconnected":
      return "Image generation was interrupted";
  }

  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (/\b(policy|safety|moderation|blocked|nsfw)\b/i.test(message)) {
    return "Image request was blocked";
  }
  if (/\b(rate|429|concurrency|busy|capacity)\b/i.test(message)) {
    return "Image service is busy";
  }
  if (/\b(auth|api key|unauthorized|forbidden|401|403)\b/i.test(message)) {
    return "Image service is not configured";
  }
  if (/\b(required|invalid|validation|422|bad request)\b/i.test(message)) {
    return "Image request was invalid";
  }
  if (/\b(timeout|timed out|deadline)\b/i.test(message)) {
    return "Image generation took too long";
  }

  return "Image generation failed";
};

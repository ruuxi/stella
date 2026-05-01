import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "./types";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "./openai_completions";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "./openai_responses";
import { streamAnthropic, streamSimpleAnthropic } from "./anthropic";
import { streamGoogle, streamSimpleGoogle } from "./google";

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
) {
  if (model.api === "openai-completions") {
    return streamOpenAICompletions(
      model as Model<"openai-completions">,
      context,
      options,
    );
  }
  if (model.api === "openai-responses") {
    return streamOpenAIResponses(
      model as Model<"openai-responses">,
      context,
      options,
    );
  }
  if (model.api === "anthropic-messages") {
    return streamAnthropic(
      model as Model<"anthropic-messages">,
      context,
      options as SimpleStreamOptions | undefined,
    );
  }
  if (model.api === "google-generative-ai") {
    return streamGoogle(
      model as Model<"google-generative-ai">,
      context,
      options as SimpleStreamOptions | undefined,
    );
  }
  throw new Error(`Unsupported API: ${model.api}`);
}

export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): Promise<AssistantMessage> {
  return await stream(model, context, options).result();
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  if (model.api === "openai-completions") {
    return streamSimpleOpenAICompletions(
      model as Model<"openai-completions">,
      context,
      options,
    );
  }
  if (model.api === "openai-responses") {
    return streamSimpleOpenAIResponses(
      model as Model<"openai-responses">,
      context,
      options,
    );
  }
  if (model.api === "anthropic-messages") {
    return streamSimpleAnthropic(
      model as Model<"anthropic-messages">,
      context,
      options,
    );
  }
  if (model.api === "google-generative-ai") {
    return streamSimpleGoogle(
      model as Model<"google-generative-ai">,
      context,
      options,
    );
  }
  throw new Error(`Unsupported API: ${model.api}`);
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return await streamSimple(model, context, options).result();
}

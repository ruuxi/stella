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
  throw new Error(`Unsupported API: ${model.api}`);
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return await streamSimple(model, context, options).result();
}

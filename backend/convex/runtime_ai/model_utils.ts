import type { Api, Model, Usage } from "./types";

export function calculateCost<TApi extends Api>(
  model: Model<TApi>,
  usage: Usage,
): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
  return (
    model.id.includes("gpt-5.2")
    || model.id.includes("gpt-5.3")
    || model.id.includes("gpt-5.4")
  );
}

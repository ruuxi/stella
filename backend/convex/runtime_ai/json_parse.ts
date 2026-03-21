import { parse as partialParse } from "partial-json";

export function parseStreamingJson<T = Record<string, unknown>>(
  partialJson: string | undefined,
): T {
  if (!partialJson || partialJson.trim() === "") {
    return {} as T;
  }

  try {
    return JSON.parse(partialJson) as T;
  } catch {
    try {
      return (partialParse(partialJson) ?? {}) as T;
    } catch {
      return {} as T;
    }
  }
}

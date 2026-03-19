export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertObject(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  assert(typeof value === "object" && value !== null, message);
}

export function errorMessage(error: unknown): string {
  assert(error instanceof Error, "Expected Error.");
  return error.message;
}

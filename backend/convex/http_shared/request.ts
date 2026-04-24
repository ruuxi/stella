import { errorResponse } from "./cors";

export type JsonBodyResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: Response };

export const readJsonBody = async <T = unknown>(
  request: Request,
  origin: string | null,
  message = "Invalid JSON body",
): Promise<JsonBodyResult<T>> => {
  try {
    return { ok: true, body: (await request.json()) as T };
  } catch {
    return { ok: false, response: errorResponse(400, message, origin) };
  }
};

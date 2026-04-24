export const encodeSseData = (payload: unknown): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);

export const sseResponse = (
  readable: ReadableStream<Uint8Array>,
  origin?: string | null,
): Response => {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return new Response(readable, { status: 200, headers });
};

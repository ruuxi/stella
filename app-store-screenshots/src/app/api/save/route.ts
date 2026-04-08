import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const OUT_DIR = path.resolve(process.cwd(), "out");

export async function POST(request: Request) {
  const { filename, dataUrl } = (await request.json()) as {
    filename: string;
    dataUrl: string;
  };

  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64, "base64");

  const dir = path.dirname(path.join(OUT_DIR, filename));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(OUT_DIR, filename), buffer);

  return NextResponse.json({ ok: true, path: path.join("out", filename) });
}

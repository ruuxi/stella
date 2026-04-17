import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const resolveStatePath = () => {
  if (process.env.STELLA_UI_STATE_DIR) {
    return process.env.STELLA_UI_STATE_DIR;
  }
  if (process.env.STELLA_HOME) {
    return path.resolve(process.env.STELLA_HOME, "state");
  }
  if (process.env.STELLA_ROOT) {
    return path.resolve(process.env.STELLA_ROOT, "state");
  }
  return path.resolve(process.cwd(), "state");
};

export const getSocketPath = () =>
  process.env.STELLA_UI_SOCKET_PATH ||
  path.join(resolveStatePath(), "stella-ui.sock");

const getPortPath = () =>
  path.join(resolveStatePath(), "stella-ui.port");

export const getTokenPath = () =>
  process.env.STELLA_UI_TOKEN_PATH || path.join(resolveStatePath(), "stella-ui.token");

const getConnectionOptions = (): { socketPath: string } | { hostname: string; port: number } => {
  if (process.env.STELLA_UI_SOCKET_PATH) {
    return { socketPath: process.env.STELLA_UI_SOCKET_PATH };
  }
  if (process.platform === "win32") {
    const port = parseInt(fs.readFileSync(getPortPath(), "utf-8").trim(), 10);
    return { hostname: "127.0.0.1", port };
  }
  return { socketPath: getSocketPath() };
};

export const runRuntimeCommand = async (args: {
  commandId: string;
  argv: string[];
  stdinText?: string | null;
}) => {
  const token = fs.readFileSync(getTokenPath(), "utf-8").trim();
  const payload = JSON.stringify({
    id: args.commandId,
    argv: args.argv,
    ...(args.stdinText == null ? {} : { stdinText: args.stdinText }),
  });

  return await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        ...getConnectionOptions(),
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "x-stella-ui-token": token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
};

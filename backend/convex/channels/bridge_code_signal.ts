// ---------------------------------------------------------------------------
// Bridge Service Code — Signal (signal-cli)
// ---------------------------------------------------------------------------

import { BRIDGE_HMAC_HELPERS } from "./bridge_code_shared";

export const SIGNAL_BRIDGE_CODE = `
const path = require("path");
const { spawn } = require("child_process");
const config = {
  webhookUrl: process.env.STELLA_BRIDGE_WEBHOOK_URL || "",
  pollUrl: process.env.STELLA_BRIDGE_POLL_URL || "",
  webhookSecret: process.env.STELLA_BRIDGE_WEBHOOK_SECRET || "",
  ownerId: process.env.STELLA_BRIDGE_OWNER_ID || "",
};
if (!config.webhookUrl || !config.pollUrl || !config.webhookSecret || !config.ownerId) {
  throw new Error("Missing required bridge environment variables.");
}

let signalProcess = null;
let bridgeMacKeyPromise = null;

${BRIDGE_HMAC_HELPERS}

async function postWebhook(body) {
  try {
    await signedPost(config.webhookUrl, {
      ...body,
      provider: "signal",
      ownerId: config.ownerId,
    });
  } catch (err) {
    console.error("[bridge] Webhook POST failed:", err.message);
  }
}

const SIGNAL_DATA = path.join(__dirname, "signal-data");
const SIGNAL_RPC_URL = "http://127.0.0.1:8081/api/v1/rpc";

async function pollForReplies() {
  while (true) {
    try {
      const res = await signedPost(config.pollUrl, {
        provider: "signal",
        ownerId: config.ownerId,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          for (const msg of data.messages) {
            try {
              if (msg.externalUserId && msg.text) {
                await sendSignalMessage(msg.externalUserId, msg.text);
              }
            } catch (err) {
              console.error("[bridge] Reply delivery error:", err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error("[bridge] Poll error:", err.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function linkSignal() {
  return new Promise((resolve, reject) => {
    const proc = spawn("signal-cli", [
      "--config", SIGNAL_DATA,
      "link", "--name", "Stella AI",
    ]);

    let linkUri = "";

    proc.stdout.on("data", (data) => {
      const line = data.toString().trim();
      const match = line.match(/tsdevice:[^\\s]+/);
      if (match) {
        linkUri = match[0];
        postWebhook({
          type: "auth_update",
          status: "awaiting_auth",
          authState: { linkUri, generatedAt: Date.now() },
        });
      }
    });

    proc.stderr.on("data", (data) => {
      console.error("[signal-cli link]", data.toString());
    });

    proc.on("close", (code) => {
      if (code === 0 && linkUri) {
        resolve(linkUri);
      } else {
        reject(new Error("signal-cli link failed with code " + code));
      }
    });
  });
}

function extractAccountId(output) {
  const lines = output
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const phone = line.match(/\\+\\d{6,15}/);
    if (phone) return phone[0];

    const uuid = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuid) return \`uuid:\${uuid[0]}\`;

    if (!line.includes(" ")) return line;
  }

  return "";
}

async function getLinkedAccountId() {
  return new Promise((resolve) => {
    const proc = spawn("signal-cli", [
      "--config", SIGNAL_DATA,
      "listAccounts",
    ]);

    let out = "";
    proc.stdout.on("data", (data) => {
      out += data.toString();
    });

    proc.on("error", () => resolve(""));
    proc.on("close", () => resolve(extractAccountId(out)));
  });
}

async function reportConnectedAndStart() {
  const externalUserId = await getLinkedAccountId();
  const authState = externalUserId
    ? { externalUserId, phoneNumber: externalUserId }
    : {};

  await postWebhook({
    type: "auth_update",
    status: "connected",
    authState,
  });
  startDaemon();
}

function startDaemon() {
  signalProcess = spawn("signal-cli", [
    "--config", SIGNAL_DATA,
    "daemon", "--json",
    "--http", "127.0.0.1:8081",
  ]);

  let buffer = "";
  signalProcess.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const envelope = msg.envelope || {};
        const dataMessage = envelope.dataMessage || {};
        const from = envelope.source || "";
        if (!from) continue;

        const groupId =
          dataMessage.groupInfo?.groupId ||
          dataMessage.groupV2?.id ||
          undefined;
        const chatType = groupId ? "group" : "dm";
        const sourceTimestamp = Number.isFinite(Number(envelope.timestamp))
          ? Number(envelope.timestamp)
          : undefined;
        const externalMessageId = Number.isFinite(Number(dataMessage.timestamp))
          ? String(dataMessage.timestamp)
          : Number.isFinite(Number(envelope.timestamp))
            ? String(envelope.timestamp)
            : undefined;
        const displayName = envelope.sourceName || "";

        const attachments = Array.isArray(dataMessage.attachments)
          ? dataMessage.attachments
              .map((attachment) => {
                if (!attachment || typeof attachment !== "object") return null;
                const contentType =
                  typeof attachment.contentType === "string"
                    ? attachment.contentType
                    : undefined;
                const kind = contentType
                  ? contentType.startsWith("image/")
                    ? "image"
                    : contentType.startsWith("video/")
                      ? "video"
                      : contentType.startsWith("audio/")
                        ? "audio"
                        : "file"
                  : "file";
                const size = Number(attachment.size);
                return {
                  id:
                    Number.isFinite(Number(attachment.id))
                      ? String(attachment.id)
                      : typeof attachment.id === "string"
                        ? attachment.id
                        : undefined,
                  name:
                    typeof attachment.filename === "string"
                      ? attachment.filename
                      : undefined,
                  mimeType: contentType,
                  size: Number.isFinite(size) ? size : undefined,
                  kind,
                };
              })
              .filter(Boolean)
          : [];

        if (dataMessage.reaction?.emoji) {
          const action = dataMessage.reaction.remove ? "remove" : "add";
          const targetMessageId = Number.isFinite(Number(dataMessage.reaction.targetSentTimestamp))
            ? String(dataMessage.reaction.targetSentTimestamp)
            : undefined;
          const summary = \`Signal reaction \${action === "add" ? "added" : "removed"}: \${dataMessage.reaction.emoji}\`;
          postWebhook({
            type: "message",
            externalUserId: from,
            text: summary,
            displayName,
            groupId,
            chatType,
            kind: "reaction" as const,
            externalMessageId,
            reactions: [
              {
                emoji: dataMessage.reaction.emoji,
                action,
                targetMessageId,
              },
            ],
            sourceTimestamp,
            respond: false,
          });
          continue;
        }

        if (dataMessage.delete?.targetSentTimestamp) {
          const targetMessageId = String(dataMessage.delete.targetSentTimestamp);
          postWebhook({
            type: "message",
            externalUserId: from,
            text: \`Signal deleted message \${targetMessageId}\`,
            displayName,
            groupId,
            chatType,
            kind: "delete" as const,
            externalMessageId: targetMessageId,
            sourceTimestamp,
            respond: false,
          });
          continue;
        }

        const text =
          typeof dataMessage.message === "string" ? dataMessage.message.trim() : "";
        const attachmentSummary =
          attachments.length > 1
            ? \`[\${attachments.length} attachments]\`
            : attachments[0]?.kind === "image"
              ? "[Image]"
              : attachments[0]?.kind === "video"
                ? "[Video]"
                : attachments[0]?.kind === "audio"
                  ? "[Audio]"
                  : attachments.length === 1
                    ? "[Attachment]"
                    : "";
        const normalizedText = text || attachmentSummary;
        if (!normalizedText) continue;

        postWebhook({
          type: "message",
          externalUserId: from,
          text: normalizedText,
          displayName,
          groupId,
          chatType,
          kind: "message" as const,
          externalMessageId,
          ...(attachments.length > 0 ? { attachments } : {}),
          sourceTimestamp,
        });
      } catch {
        // best-effort: skip unparseable daemon messages
      }
    }
  });

  signalProcess.stderr.on("data", (data) => {
    console.error("[signal-cli daemon]", data.toString());
  });

  signalProcess.on("close", (code) => {
    console.error("[signal-cli daemon] Exited with code", code);
    postWebhook({ type: "error", error: "signal-cli daemon exited with code " + code });
  });
}

async function sendSignalMessage(recipient, message) {
  const res = await fetch(SIGNAL_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "send",
      params: {
        recipient: [recipient],
        message,
      },
      id: Date.now(),
    }),
  });

  if (!res.ok) {
    throw new Error(\`Signal RPC send failed: HTTP \${res.status}\`);
  }

  const payload = await res.json().catch(() => null);
  if (payload?.error) {
    throw new Error(payload.error?.message || "Signal RPC send failed");
  }
}

// Heartbeat
setInterval(() => postWebhook({ type: "heartbeat" }), 60000);

async function bootstrapSignal() {
  const existingAccount = await getLinkedAccountId();
  if (existingAccount) {
    await reportConnectedAndStart();
    return;
  }

  await linkSignal();
  await reportConnectedAndStart();
}

bootstrapSignal().catch((err) => {
  console.error("[bridge] Signal startup failed:", err);
  postWebhook({ type: "error", error: err.message });
});

// Start reply poll loop
pollForReplies();
`.trim();

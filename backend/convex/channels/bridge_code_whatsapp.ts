// ---------------------------------------------------------------------------
// Bridge Service Code — WhatsApp (Baileys)
// ---------------------------------------------------------------------------

import { BRIDGE_HMAC_HELPERS } from "./bridge_code_shared";

export const WHATSAPP_BRIDGE_CODE = `
const path = require("path");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");

const config = {
  webhookUrl: process.env.STELLA_BRIDGE_WEBHOOK_URL || "",
  pollUrl: process.env.STELLA_BRIDGE_POLL_URL || "",
  webhookSecret: process.env.STELLA_BRIDGE_WEBHOOK_SECRET || "",
  ownerId: process.env.STELLA_BRIDGE_OWNER_ID || "",
};
if (!config.webhookUrl || !config.pollUrl || !config.webhookSecret || !config.ownerId) {
  throw new Error("Missing required bridge environment variables.");
}

const logger = pino({ level: "silent" });
let sock = null;
let bridgeMacKeyPromise = null;

${BRIDGE_HMAC_HELPERS}

async function postWebhook(body) {
  try {
    await signedPost(config.webhookUrl, {
      ...body,
      provider: "whatsapp",
      ownerId: config.ownerId,
    });
  } catch (err) {
    console.error("[bridge] Webhook POST failed:", err.message);
  }
}

async function pollForReplies() {
  while (true) {
    try {
      const res = await signedPost(config.pollUrl, {
        provider: "whatsapp",
        ownerId: config.ownerId,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          for (const msg of data.messages) {
            try {
              if (sock && msg.externalUserId && msg.text) {
                await sock.sendMessage(msg.externalUserId, { text: msg.text });
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

async function startWhatsApp() {
  const authStatePath = path.join(__dirname, "auth_state");
  const { state, saveCreds } = await useMultiFileAuthState(authStatePath);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      await postWebhook({
        type: "auth_update",
        status: "awaiting_auth",
        authState: { qrCode: qrDataUrl, generatedAt: Date.now() },
      });
    }

    if (connection === "open") {
      const phoneNumber = sock.user?.id?.split(":")[0] || "";
      await postWebhook({
        type: "auth_update",
        status: "connected",
        authState: { phoneNumber, externalUserId: phoneNumber },
      });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        await postWebhook({
          type: "error",
          error: "WhatsApp logged out. Please re-scan QR code.",
        });
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const toSize = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : undefined;
    };

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const message = msg.message || {};
      const from = msg.key.remoteJid;
      if (!from) continue;
      const pushName = msg.pushName || "";
      const isGroup = typeof from === "string" && from.endsWith("@g.us");
      const groupId = isGroup ? from : undefined;
      const externalMessageId = msg.key.id || undefined;
      const sourceTimestamp = Number.isFinite(Number(msg.messageTimestamp))
        ? Number(msg.messageTimestamp) * 1000
        : undefined;

      const attachments = [];
      if (message.imageMessage) {
        attachments.push({
          id: externalMessageId,
          mimeType: message.imageMessage.mimetype,
          size: toSize(message.imageMessage.fileLength),
          kind: "image" as const,
        });
      }
      if (message.videoMessage) {
        attachments.push({
          id: externalMessageId,
          mimeType: message.videoMessage.mimetype,
          size: toSize(message.videoMessage.fileLength),
          kind: "video" as const,
        });
      }
      if (message.documentMessage) {
        attachments.push({
          id: externalMessageId,
          name: message.documentMessage.fileName,
          mimeType: message.documentMessage.mimetype,
          size: toSize(message.documentMessage.fileLength),
          kind: "document" as const,
        });
      }
      if (message.audioMessage) {
        attachments.push({
          id: externalMessageId,
          mimeType: message.audioMessage.mimetype,
          size: toSize(message.audioMessage.fileLength),
          kind: message.audioMessage.ptt ? "voice" : "audio",
        });
      }
      if (message.stickerMessage) {
        attachments.push({
          id: externalMessageId,
          mimeType: message.stickerMessage.mimetype,
          kind: "sticker" as const,
        });
      }

      const reactionEmoji = message.reactionMessage?.text || "";
      if (reactionEmoji) {
        const targetMessageId = message.reactionMessage?.key?.id || undefined;
        const summary = \`WhatsApp reaction \${reactionEmoji} on message \${targetMessageId || "unknown"}\`;
        await postWebhook({
          type: "message",
          externalUserId: from,
          text: summary,
          displayName: pushName,
          groupId,
          chatType: isGroup ? "group" : "dm",
          kind: "reaction" as const,
          externalMessageId,
          reactions: [{ emoji: reactionEmoji, action: "add", targetMessageId }],
          sourceTimestamp,
          respond: false,
        });
        continue;
      }

      if (message.protocolMessage?.key?.id) {
        const targetMessageId = message.protocolMessage.key.id;
        await postWebhook({
          type: "message",
          externalUserId: from,
          text: \`WhatsApp deleted message \${targetMessageId}\`,
          displayName: pushName,
          groupId,
          chatType: isGroup ? "group" : "dm",
          kind: "delete" as const,
          externalMessageId: targetMessageId,
          sourceTimestamp,
          respond: false,
        });
        continue;
      }

      const text =
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        "";
      const attachmentSummary =
        attachments.length > 1
          ? \`[\${attachments.length} attachments]\`
          : attachments[0]?.kind === "image"
            ? "[Image message]"
            : attachments[0]?.kind === "video"
              ? "[Video message]"
              : attachments[0]?.kind === "voice"
                ? "[Voice message]"
                : attachments[0]?.kind === "audio"
                  ? "[Audio message]"
                  : attachments[0]?.kind === "document"
                    ? "[Document message]"
                    : attachments[0]?.kind === "sticker"
                      ? "[Sticker]"
                      : "";
      const normalizedText = (text || attachmentSummary).trim();
      if (!normalizedText) continue;

      await postWebhook({
        type: "message",
        externalUserId: from,
        text: normalizedText,
        displayName: pushName,
        groupId,
        chatType: isGroup ? "group" : "dm",
        kind: "message" as const,
        externalMessageId,
        ...(attachments.length > 0 ? { attachments } : {}),
        sourceTimestamp,
      });
    }
  });
}

// Heartbeat
setInterval(() => postWebhook({ type: "heartbeat" }), 60000);

// Start
startWhatsApp().catch((err) => {
  console.error("[bridge] WhatsApp startup failed:", err);
  postWebhook({ type: "error", error: err.message });
});

// Start reply poll loop
pollForReplies();
`.trim();

import makeWASocket, {
  Browsers,
  DisconnectReason,
  extractMessageContent,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type proto,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import path from "node:path";
import { insertMessage } from "./db.js";

const AUTH_DIR = path.resolve(process.cwd(), "auth");
const logger = pino({ level: "silent" });
const nameCache = new Map<string, string>();

function cacheName(jid: string | undefined | null, name: string | undefined | null): void {
  if (!jid || !name) return;
  nameCache.set(jid, name);
}

function displayName(jid: string, fallback?: string | null): string {
  return nameCache.get(jid) || fallback || jid.split("@")[0] || jid;
}

function unwrapContent(message: proto.IMessage | null | undefined): proto.IMessage | undefined {
  if (!message) return undefined;
  return extractMessageContent(message) ?? message;
}

function mediaPlaceholder(kind: string, caption?: string | null): string {
  const tag = `[${kind}]`;
  const trimmed = caption?.trim();
  return trimmed ? `${trimmed} ${tag}` : tag;
}

function extractText(raw: proto.IMessage | null | undefined): string | null {
  const content = unwrapContent(raw);
  if (!content) return null;

  const type = getContentType(content);
  if (!type) return null;

  switch (type) {
    case "conversation":
      return content.conversation?.trim() || null;
    case "extendedTextMessage":
      return content.extendedTextMessage?.text?.trim() || null;
    case "imageMessage":
      return mediaPlaceholder("image", content.imageMessage?.caption);
    case "videoMessage":
      return mediaPlaceholder("video", content.videoMessage?.caption);
    case "audioMessage":
      return content.audioMessage?.ptt ? "[voice note]" : "[audio]";
    case "stickerMessage":
      return "[sticker]";
    case "documentMessage": {
      const name = content.documentMessage?.fileName;
      return name ? `[document: ${name}]` : "[document]";
    }
    case "documentWithCaptionMessage": {
      const doc = content.documentWithCaptionMessage?.message?.documentMessage;
      const caption = doc?.caption;
      const name = doc?.fileName;
      const label = name ? `[document: ${name}]` : "[document]";
      return caption?.trim() ? `${caption.trim()} ${label}` : label;
    }
    case "contactMessage":
      return `[contact: ${content.contactMessage?.displayName || "unknown"}]`;
    case "contactsArrayMessage":
      return "[contacts]";
    case "locationMessage":
      return "[location]";
    case "liveLocationMessage":
      return "[live location]";
    case "reactionMessage":
      return `[reaction: ${content.reactionMessage?.text || "?"}]`;
    case "pollCreationMessage":
    case "pollCreationMessageV3":
      return "[poll]";
    case "protocolMessage":
      return null;
    default:
      return `[${type.replace(/Message$/, "").toLowerCase()}]`;
  }
}

function messageTimestampMs(msg: WAMessage): number {
  const ts = msg.messageTimestamp;
  const n = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

function shouldSkipJid(jid: string): boolean {
  return Boolean(
    isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid),
  );
}

function persistWaMessage(msg: WAMessage): void {
  const chatId = msg.key.remoteJid;
  if (!chatId || shouldSkipJid(chatId)) return;
  if (msg.key.fromMe) return;

  const text = extractText(msg.message);
  if (!text) return;

  const isGroup = Boolean(isJidGroup(chatId));
  const senderJid = isGroup ? msg.key.participant || chatId : chatId;
  const sender = displayName(senderJid, msg.pushName);
  const chatName = isGroup ? displayName(chatId, msg.pushName) : sender;

  if (msg.pushName) {
    cacheName(senderJid, msg.pushName);
    if (!isGroup) cacheName(chatId, msg.pushName);
  }

  const inserted = insertMessage({
    messageId: msg.key.id || `${chatId}-${messageTimestampMs(msg)}`,
    chatId,
    chatName,
    sender,
    text,
    timestamp: messageTimestampMs(msg),
    isGroup,
  });

  if (inserted) {
    const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    console.log(`[stored] ${chatName}: ${preview}`);
  }
}

function rememberContacts(
  contacts: Array<{ id?: string | null; notify?: string | null; name?: string | null; verifiedName?: string | null }>,
): void {
  for (const contact of contacts) {
    cacheName(contact.id, contact.notify || contact.name || contact.verifiedName);
  }
}

export async function connectWhatsApp(): Promise<WASocket> {
  const { version } = await fetchLatestBaileysVersion();

  return new Promise<WASocket>((resolve, reject) => {
    let settled = false;

    const start = async (): Promise<void> => {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: Browsers.ubuntu("WTS Important Message"),
        syncFullHistory: false,
      });

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("contacts.upsert", rememberContacts);
      sock.ev.on("contacts.update", rememberContacts);

      sock.ev.on("chats.upsert", (chats) => {
        for (const chat of chats) {
          cacheName(chat.id, chat.name);
        }
      });

      sock.ev.on("chats.update", (updates) => {
        for (const chat of updates) {
          cacheName(chat.id, chat.name);
        }
      });

      sock.ev.on("groups.update", (updates) => {
        for (const group of updates) {
          cacheName(group.id, group.subject);
        }
      });

      sock.ev.on("messages.upsert", ({ messages }) => {
        for (const message of messages) {
          persistWaMessage(message);
        }
      });

      sock.ev.on("messaging-history.set", ({ messages }) => {
        for (const message of messages) {
          persistWaMessage(message);
        }
      });

      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log("\nScan this QR code in WhatsApp → Linked devices:\n");
          qrcode.generate(qr, { small: true });
          console.log("");
        }

        if (connection === "open") {
          console.log("WhatsApp connected.");
          if (!settled) {
            settled = true;
            resolve(sock);
          }
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (loggedOut) {
            console.error(
              "Logged out. Delete the ./auth folder and run again to scan a new QR code.",
            );
            if (!settled) {
              settled = true;
              reject(new Error("WhatsApp session logged out"));
            }
            process.exit(1);
          }

          console.log("Connection closed. Reconnecting in 2s...");
          setTimeout(() => {
            start().catch((err) => {
              if (!settled) {
                settled = true;
                reject(err);
              } else {
                console.error("Reconnect failed:", err);
              }
            });
          }, 2000);
        }
      });
    };

    start().catch((err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

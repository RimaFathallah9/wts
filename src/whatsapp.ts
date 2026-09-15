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
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type proto,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { insertMessage } from "./db.js";
import { chunkWhatsAppText } from "./format.js";

const AUTH_DIR = path.resolve(process.cwd(), "auth");
const logger = pino({ level: "silent" });
const nameCache = new Map<string, string>();

let currentSock: WASocket | null = null;

export function getSocket(): WASocket | null {
  return currentSock;
}

export async function sendSummaryToSelf(markdown: string): Promise<void> {
  const sock = currentSock;
  if (!sock?.user?.id) {
    throw new Error("WhatsApp is not connected yet.");
  }

  const jid = jidNormalizedUser(sock.user.id);
  for (const chunk of chunkWhatsAppText(markdown)) {
    await sock.sendMessage(jid, { text: chunk });
  }

  console.log(`Sent summary to your own WhatsApp chat (${jid}). Open WhatsApp Web to read it.`);
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

async function getPhoneNumber(): Promise<string> {
  const fromEnv = process.env.WHATSAPP_PHONE?.trim();
  if (fromEnv) {
    const phone = digitsOnly(fromEnv);
    if (phone.length < 8) {
      throw new Error("WHATSAPP_PHONE must include country code, digits only, e.g. 351912345678");
    }
    return phone;
  }

  if (!input.isTTY) {
    throw new Error(
      "Set WHATSAPP_PHONE in .env (country code + number, no + or spaces), then run again. No QR code is used.",
    );
  }

  const rl = readline.createInterface({ input, output });
  const raw = await rl.question(
    "Phone number with country code (digits only, e.g. 351912345678): ",
  );
  rl.close();
  const phone = digitsOnly(raw);
  if (phone.length < 8) {
    throw new Error("That number looks too short. Include the country code.");
  }
  return phone;
}

function formatPairingCode(code: string): string {
  return code.replace(/(.{4})/g, "$1-").replace(/-$/, "");
}

async function requestAndPrintPairingCode(sock: WASocket, phone: string): Promise<void> {
  if (sock.authState.creds.registered) return;

  console.log(`Requesting a pairing code for +${phone} (no QR)...`);
  await sleep(5000);
  if (sock.authState.creds.registered) return;

  const code = await sock.requestPairingCode(phone);
  console.log(`
============================================================
  PAIRING CODE:  ${formatPairingCode(code)}
============================================================

Enter it here (you have about 60 seconds):
  WhatsApp → Settings → Linked devices → Link a device
  → Link with phone number instead

Keep THIS window open. Do not press Ctrl+C.
If the code expires, a new one will be printed automatically.
`);
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
  const { state: initialState } = await useMultiFileAuthState(AUTH_DIR);

  let phone = "";
  if (!initialState.creds.registered) {
    phone = await getPhoneNumber();
    if (fs.existsSync(AUTH_DIR)) {
      console.log("Clearing incomplete login files so the pairing code is not killed immediately...");
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  }

  return new Promise<WASocket>((resolve, reject) => {
    let settled = false;
    let starting = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = (delayMs: number, reason: string): void => {
      if (reconnectTimer) return;
      console.log(`${reason} Retrying in ${Math.round(delayMs / 1000)}s. Do not press Ctrl+C.`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void start();
      }, delayMs);
    };

    const start = async (): Promise<void> => {
      if (starting) return;
      starting = true;

      try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        const sock = makeWASocket({
          version,
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
          },
          logger,
          browser: Browsers.ubuntu("Chrome"),
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
          const { connection, lastDisconnect } = update;

          if (connection === "open") {
            currentSock = sock;
            console.log("WhatsApp connected (staying online like WhatsApp Web).");
            if (!settled) {
              settled = true;
              resolve(sock);
            }
            return;
          }

          if (connection !== "close") return;

          starting = false;
          const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          const registered = sock.authState.creds.registered;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (loggedOut && registered) {
            console.error(
              "Logged out. Delete the ./auth folder, set WHATSAPP_PHONE in .env, and run again.",
            );
            if (!settled) {
              settled = true;
              reject(new Error("WhatsApp session logged out"));
            }
            process.exit(1);
            return;
          }

          if (!registered) {
            scheduleReconnect(
              8000,
              "Still waiting for the pairing code (WhatsApp closed the socket — that is normal).",
            );
            return;
          }

          scheduleReconnect(2000, "Connection closed.");
        });

        if (!state.creds.registered && phone) {
          requestAndPrintPairingCode(sock, phone).catch((err) => {
            console.error("Could not request a pairing code:", err);
            starting = false;
            scheduleReconnect(8000, "Pairing request failed.");
          });
        }
      } catch (err) {
        starting = false;
        if (!settled) {
          scheduleReconnect(8000, "Socket failed to start.");
        } else {
          console.error("Reconnect failed:", err);
        }
      }
    };

    start().catch((err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

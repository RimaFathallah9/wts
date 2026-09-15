import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { insertMessage } from "./db.js";
import { chunkWhatsAppText } from "./format.js";

const require = createRequire(import.meta.url);
const wwebjs = require("whatsapp-web.js") as {
  Client: new (opts: Record<string, unknown>) => WebClient;
  NoAuth: new () => unknown;
  LocalAuth: new (opts?: { dataPath?: string }) => unknown;
};

type WebMessage = {
  id: { _serialized?: string };
  from: string;
  author?: string | null;
  fromMe: boolean;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  type: string;
  notifyName?: string;
  getChat: () => Promise<{ name?: string; isGroup?: boolean; id?: { _serialized?: string } }>;
};

type WebClient = {
  info?: { wid: { _serialized: string } };
  initialize: () => Promise<void>;
  sendMessage: (chatId: string, content: string) => Promise<unknown>;
  getChats: () => Promise<
    Array<{
      name?: string;
      isGroup?: boolean;
      id?: { _serialized?: string };
      fetchMessages: (opts: { limit: number }) => Promise<WebMessage[]>;
    }>
  >;
  on: (event: string, listener: (...args: never[]) => void) => WebClient;
  once: (event: string, listener: (...args: never[]) => void) => WebClient;
};

const TWO_HOURS_S = 2 * 60 * 60;

let webClient: WebClient | null = null;

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH && exists(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const localApp = process.env.LOCALAPPDATA || "";
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(localApp, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(localApp, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];

  return candidates.find(exists);
}

function chromeUserDataDir(): string | undefined {
  if (process.env.CHROME_USER_DATA) return process.env.CHROME_USER_DATA;
  const localApp = process.env.LOCALAPPDATA;
  if (!localApp) return undefined;
  const dir = path.join(localApp, "Google", "Chrome", "User Data");
  return exists(dir) ? dir : undefined;
}

function mediaPlaceholder(msg: WebMessage): string {
  const kind = msg.type === "ptt" ? "voice note" : msg.type || "media";
  const body = msg.body?.trim();
  return body ? `${body} [${kind}]` : `[${kind}]`;
}

async function persistWebMessage(msg: WebMessage): Promise<void> {
  if (msg.fromMe) return;
  if (msg.from === "status@broadcast") return;

  const chat = await msg.getChat();
  const isGroup = Boolean(chat.isGroup);
  const chatId = chat.id?._serialized || msg.from;
  const sender = isGroup ? msg.notifyName || msg.author || msg.from : chat.name || msg.notifyName || msg.from;
  const chatName = chat.name || sender;
  const text = msg.hasMedia && !msg.body?.trim() ? mediaPlaceholder(msg) : msg.body?.trim() || mediaPlaceholder(msg);
  if (!text) return;

  const ts = msg.timestamp < 1e12 ? msg.timestamp * 1000 : msg.timestamp;
  const inserted = insertMessage({
    messageId: msg.id._serialized || `${chatId}-${ts}`,
    chatId,
    chatName,
    sender,
    text,
    timestamp: ts,
    isGroup,
  });

  if (inserted) {
    const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    console.log(`[stored] ${chatName}: ${preview}`);
  }
}

async function backfill(client: WebClient): Promise<void> {
  const cutoff = Date.now() / 1000 - TWO_HOURS_S;
  try {
    const chats = await client.getChats();
    for (const chat of chats.slice(0, 40)) {
      const messages = await chat.fetchMessages({ limit: 30 });
      for (const msg of messages) {
        if (msg.timestamp >= cutoff) {
          await persistWebMessage(msg);
        }
      }
    }
  } catch (err) {
    console.warn("Could not backfill recent WhatsApp Web chats:", err);
  }
}

export async function sendSummaryToSelf(markdown: string): Promise<void> {
  if (!webClient?.info?.wid) {
    throw new Error("WhatsApp Web is not connected yet.");
  }

  const jid = webClient.info.wid._serialized;
  for (const chunk of chunkWhatsAppText(markdown)) {
    await webClient.sendMessage(jid, chunk);
  }

  console.log(`Sent summary to your own WhatsApp chat (${jid}). Open WhatsApp Web to read it.`);
}

export async function connectWhatsAppWeb(): Promise<void> {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error(
      "Chrome/Edge was not found. Set CHROME_PATH in .env to chrome.exe, or use pairing login (WHATSAPP_PHONE).",
    );
  }

  const userDataDir = chromeUserDataDir();
  const profile = process.env.CHROME_PROFILE || "Default";
  const useExistingProfile = Boolean(userDataDir);

  if (useExistingProfile) {
    console.log("Using your existing Chrome WhatsApp Web session.");
    console.log("Close every Chrome window first, or Chrome will refuse to share the profile.");
    console.log(`Profile: ${userDataDir} (${profile})`);
  }

  const client = new wwebjs.Client({
    authStrategy: useExistingProfile
      ? new wwebjs.NoAuth()
      : new wwebjs.LocalAuth({ dataPath: path.resolve(process.cwd(), ".wwebjs_auth") }),
    puppeteer: {
      headless: false,
      executablePath: chrome,
      userDataDir: useExistingProfile ? userDataDir : path.resolve(process.cwd(), "chrome-profile"),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        `--profile-directory=${profile}`,
      ],
    },
  });

  webClient = client;

  client.on("message", ((msg: WebMessage) => {
    void persistWebMessage(msg);
  }) as (...args: never[]) => void);

  await new Promise<void>((resolve, reject) => {
    client.once("ready", (() => {
      console.log("WhatsApp Web connected (no QR).");
      void backfill(client).finally(() => resolve());
    }) as (...args: never[]) => void);

    client.once("auth_failure", ((message: string) => {
      reject(new Error(`WhatsApp Web auth failed: ${message}`));
    }) as (...args: never[]) => void);

    client.on("qr", (() => {
      console.error(
        "This browser profile is not logged into WhatsApp Web, so WhatsApp showed a QR in the window.",
      );
      console.error("Close that window. Use pairing instead:");
      console.error("  1. Put WHATSAPP_PHONE=yourNumber in .env (country code, no +)");
      console.error("  2. Run: npm.cmd run start");
      console.error("  3. Enter the pairing code under Linked devices → Link with phone number instead");
      reject(new Error("WhatsApp Web profile is not logged in; refusing QR login."));
    }) as (...args: never[]) => void);

    client.initialize().catch(reject);
  });
}
